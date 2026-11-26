using System.Globalization;
using System.Text.RegularExpressions;
using Google.Apis.Bigquery.v2.Data;

namespace Varia.Backend.Search;

/// <summary>What the index reads from BigQuery (BigQueryService implements it with free REST calls through the principal's limiter).</summary>
internal interface IBigQueryIndexSource
{
    /// <summary>The connection's billing project; throws NOT_CONNECTED.</summary>
    string BillingProject(string connectionId);
    /// <summary>Whether BigQuery is refusing the connection's principal for its rate right now (the build's progress says so).</summary>
    bool Throttled(string connectionId) => false;
    /// <summary>Every accessible project via projects.list, sorted ordinally and capped at <paramref name="maxProjects"/>.</summary>
    Task<BigQueryProjectDiscovery> AccessibleProjectsAsync(string connectionId, int maxProjects, CancellationToken token);
    Task<BigQueryDatasetList> DatasetsAsync(string connectionId, string project, CancellationToken token);
    Task<BigQueryListing> ObjectsAsync(string connectionId, string project, string dataset, CancellationToken token);
    Task<Table> TableAsync(string connectionId, string project, string dataset, string table, CancellationToken token);
    Task<Routine> RoutineAsync(string connectionId, string project, string dataset, string routine, CancellationToken token);
    /// <summary>The billed bulk path's rows for one project's location (<see cref="BigQueryBulkSql"/>), a dataset at a time in name order,
    /// under the cap. Leaving early cancels its jobs; a failed job throws as a job's failure does.</summary>
    IAsyncEnumerable<BigQueryBulkDataset> BulkAsync(string connectionId, string project, string location, bool definitions, long? cap, BigQueryBulkBudget budget,
        Func<string, string, bool> wanted, CancellationToken token);
    /// <summary>A failed read as a RequestException with BigQuery's code and a sentence that names no object.</summary>
    Exception Map(Exception error, string project, string? permission, CancellationToken token);
}

/// <summary>The accessible projects projects.list returned, deduplicated and sorted ordinally; Cut when more than
/// <see cref="BigQueryIndexLimits.MaxProjects"/> existed.</summary>
internal sealed record BigQueryProjectDiscovery(List<string> Projects, bool Cut);
/// <summary>A project's datasets, each one's location as datasets.list gives it (the bulk path's regions); Cut when the listing
/// stopped at <see cref="BigQueryIndexLimits.ListPages"/>.</summary>
internal sealed record BigQueryDatasetList(List<string> Datasets, bool Cut, IReadOnlyDictionary<string, string>? Locations = null);
/// <summary>A dataset's objects as tables.list, routines.list and models.list give them; Cut when a listing stopped at its page cap.</summary>
internal sealed record BigQueryListing(List<TableList.TablesData> Tables, List<Routine> Routines, List<Model> Models, bool Cut);

/// <summary>The BigQuery index's own bounds (objectSearchLimits.bigQuery in src/shared/explorer/search.ts).</summary>
internal static class BigQueryIndexLimits
{
    /// <summary>Pages one listing reads (1,000 items each) before it stops and the dataset is marked TOO_LARGE with what it read.</summary>
    public const int ListPages = 500;
    /// <summary>Datasets listed at once in pass 1 (each lists its tables, routines and models one after another).</summary>
    public const int Datasets = 32;
    /// <summary>tables.get and routines.get calls one build keeps in flight in pass 2: enough for the principal's limiter, which paces
    /// each method at BigQuery's per-user rate, to be the ceiling.</summary>
    public const int Details = 64;
    /// <summary>Columns, nested fields included, one table keeps; the rest are left out and the table counts as cut.</summary>
    public const int Columns = 10_000;
    /// <summary>The longest column description or routine signature kept.</summary>
    public const int FactChars = 1024;
    /// <summary>The default number of accessible projects projects.list discovery keeps in one build.</summary>
    public const int MaxProjects = 500;
    /// <summary>The upper bound for the configurable accessible projects cap.</summary>
    public const int MaxProjectsCap = 5000;
    /// <summary>Projects whose datasets are listed concurrently in wave 2.</summary>
    public const int Projects = 16;
    /// <summary>Datasets whose listing goes past its first page (1,000 items) at once, across every build: what a listing read is
    /// outside the index's budget until the dataset is held.</summary>
    public const int LargeListings = 4;
    /// <summary>Objects whose details the datasets in pass 2 may read at once (a larger dataset reads alone): details are outside
    /// the index's budget until their dataset is held.</summary>
    public const int DetailObjects = 4096;
    /// <summary>The most starred projects one build or estimate accepts (matches BigQueryLimits.StarredProjects).</summary>
    public const int StarredProjects = 200;
}

/// <summary>
/// Admits datasets to pass 2 by how many objects they read: together at most <c>permits</c>, or one dataset alone when it reads
/// more. First come, first admitted, so a large dataset is never passed over by smaller ones.
/// </summary>
internal sealed class BigQueryDetailAdmission(int permits)
{
    private readonly object gate = new();
    private readonly LinkedList<(int Count, TaskCompletionSource Ready)> waiting = new();
    private int used;
    private int active;

    /// <summary>Objects and datasets admitted now (the checks read them).</summary>
    public (int Used, int Active) Admitted { get { lock (gate) return (used, active); } }

    /// <summary>Waits until the dataset's <paramref name="count"/> objects may be read; disposing the result lets others in.</summary>
    public async Task<IDisposable> EnterAsync(int count, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        LinkedListNode<(int Count, TaskCompletionSource Ready)> node;
        lock (gate)
        {
            if (waiting.Count == 0 && Fits(count))
            {
                used += count;
                active++;
                return new Ticket(this, count);
            }
            node = waiting.AddLast((count, new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously)));
        }
        using (token.Register(() =>
        {
            lock (gate)
            {
                if (node.List is null) return;
                waiting.Remove(node);
                node.Value.Ready.TrySetCanceled(token);
                GrantLocked();
            }
        }))
            await node.Value.Ready.Task;
        return new Ticket(this, count);
    }

    bool Fits(int count) => active == 0 || used + count <= permits;

    void GrantLocked()
    {
        while (waiting.First is { } first && Fits(first.Value.Count))
        {
            waiting.RemoveFirst();
            used += first.Value.Count;
            active++;
            first.Value.Ready.TrySetResult();
        }
    }

    void Leave(int count)
    {
        lock (gate)
        {
            used -= count;
            active--;
            GrantLocked();
        }
    }

    sealed class Ticket(BigQueryDetailAdmission owner, int count) : IDisposable
    {
        private int done;
        public void Dispose() { if (Interlocked.Exchange(ref done, 1) == 0) owner.Leave(count); }
    }
}

/// <summary>A BigQuery build's explorer.index.progress EVENT: <c>Growing</c> while projects still being listed may add datasets to
/// the total, <c>Throttled</c> while BigQuery refuses the principal for its rate; both are left out when false.</summary>
internal sealed record BigQueryIndexProgress(int Done, int Total, int Objects, string Phase,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] bool? Growing = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] bool? Throttled = null)
{
    public string Type => "explorer.index.progress";
}

/// <summary>A date-sharded group or one object as pass 1 lists it, with what pass 2 (or an earlier read) knows of it.</summary>
internal sealed record BigQueryEntry(string Kind, string Folder, string? Subtype, string Name, long Created, long? Modified,
    Varia.Backend.BigQueryShardsDto? Shards = null, BigQueryDetail? Detail = null);

/// <summary>A column or nested field: its path (address.city), whether it is a STRUCT, its type text, whether it may be NULL, and its description.</summary>
internal sealed record BigQueryColumn(string Path, bool Record, string Type, bool Nullable, string? Description);

/// <summary>What pass 2 read of an object: a clone's subtype, its last change, its view or routine text, columns, size and layout.</summary>
/// <c>Bulk</c>: read by the billed bulk path, which has no size, layout, signature or last change, so no later build reuses it.
/// <c>Carried</c>: an earlier read's details that were not whole, held only until pass 2 reads the object again; never reused either.
internal sealed record BigQueryDetail(string? Subtype, long? Modified, string? Definition, IReadOnlyList<BigQueryColumn> Columns, long? Rows = null, long? Bytes = null,
    string? Partitioning = null, string? Clustering = null, string? Signature = null, bool ColumnsCut = false, bool DefinitionCut = false, bool Bulk = false, bool Carried = false);

/// <summary>An object's facts beside its entry: when it was created (what a refresh compares), whether pass 2 read it, and what it read.</summary>
/// <c>Whole</c>: the read kept all pass 2 gave (its text was not left out for the names' reserve), so a later build may reuse it.
/// <c>Listed</c>: the listing's last change to the millisecond (routines and models), which the index's dates keep only to the second.
internal readonly record struct BigQueryObjectFacts(long Created, bool Detailed, long? Rows = null, long? Bytes = null, string? Partitioning = null, string? Clustering = null, string? Signature = null,
    bool Whole = true, bool ColumnsCut = false, long? Listed = null);

/// <summary>
/// A BigQuery read's facts beside its <see cref="ObjectTable"/> (by entry): creation times and whether details were read, rows, size,
/// partitioning, clustering, a routine's signature, column descriptions and date-sharded groups. Charged to the budget with the read
/// (<see cref="Bytes"/>). The editor's hover reads them with the entries' types.
/// </summary>
internal sealed class BigQueryFacts(Dictionary<int, BigQueryObjectFacts> objects, Dictionary<int, string> descriptions, Dictionary<int, Varia.Backend.BigQueryShardsDto> shards)
{
    public const long ObjectBytes = 64, DescriptionBytes = 16, ShardBytes = 64;

    public BigQueryObjectFacts? Of(int at) => objects.TryGetValue(at, out var value) ? value : null;
    public string? Description(int at) => descriptions.GetValueOrDefault(at);
    public Varia.Backend.BigQueryShardsDto? Shards(int at) => shards.GetValueOrDefault(at);
    public int Count => objects.Count;

    /// <summary>Whether a kind is BigQuery's (the catalogue's bq* kinds).</summary>
    public static bool IsBigQuery(string kind) => kind.StartsWith("bq", StringComparison.Ordinal);

    /// <summary>The Object Explorer ref of a BigQuery entry: project and dataset in place of database and schema, a column's table by name.</summary>
    public static Varia.Backend.ObjectRefDto RefOf(ObjectTable table, int at, string project)
    {
        var kind = table.Kind(at);
        var name = table.Name(at);
        if (kind == "bqDataset") return new(kind, Name: name, Project: project);
        var parent = table.Parent(at);
        if (parent >= 0) return new(kind, Name: name, Project: project, Dataset: table.Schema(parent), Table: table.Name(parent));
        return new(kind, Name: name, Project: project, Dataset: table.Schema(at));
    }
}

/// <summary>
/// Builds one BigQuery dataset's read (<see cref="DatabaseIndex"/>, Database the project, Dataset the dataset) from pass 1's listing
/// and what pass 2 or an earlier read knows: the dataset itself, its objects (Schema the dataset), and each table-like object's
/// columns as children named by field path (address.city) with their types in the table's details. Names and definitions are the
/// shared <see cref="StringPool"/>'s and every record is charged to the budget, from the share of the read it replaces first, as
/// SQL Server's <see cref="DatabaseReader"/> charges; a read past the budget answers null. What it takes beyond that share must
/// leave a floor of the budget free, so BigQuery never crowds out SQL Server's definitions (<see cref="ObjectIndexLimits.BigQueryNamesFloorBytes"/>):
/// <paramref name="namesFloor"/> for the dataset, its objects and their facts, and <paramref name="detailsFloor"/>, which is
/// higher and so gives way first, for columns (a read past it answers null, and is read again without them) and for view and
/// routine text (left out, counted as cut).
/// </summary>
internal sealed class BigQueryReader(ObjectIndexLimits limits, StringPool pool, DatabaseIndex? credit, long namesFloor = 0, long detailsFloor = 0)
{
    private readonly IndexBudget budget = pool.Budget;
    private long taken, credited, creditLeft = credit?.Bytes ?? 0;
    private int modules, cut, leftOut;
    private readonly ObjectTable.Builder objects = new();
    private readonly Dictionary<int, BigQueryObjectFacts> facts = [];
    private readonly Dictionary<int, string> descriptions = [];
    private readonly Dictionary<int, Varia.Backend.BigQueryShardsDto> shards = [];
    private readonly Dictionary<string, ushort> types = new(StringComparer.Ordinal);

    private sealed class TooLarge : Exception;

    private bool TryCharge(long bytes, long keepFree)
    {
        if (creditLeft >= bytes) { creditLeft -= bytes; credited += bytes; return true; }
        if (!budget.TryTake(bytes, keepFree)) return false;
        taken += bytes;
        return true;
    }

    /// <summary>Charges a name's share (a record, its facts, a text's slot): to the budget above the names floor when it has the
    /// room, else to the credit. The credit is kept for the details the earlier read held, so a new object's name never pushes
    /// a held column out of it and up against the details' floor.</summary>
    private bool TryChargeName(long bytes)
    {
        if (budget.TryTake(bytes, namesFloor)) { taken += bytes; return true; }
        if (creditLeft < bytes) return false;
        creditLeft -= bytes;
        credited += bytes;
        return true;
    }

    private void Charge(long bytes)
    {
        if (!TryChargeName(bytes)) throw new TooLarge();
    }

    /// <summary>Charges a column's share (its record, type and description) above the details' floor.</summary>
    private void ChargeDetail(long bytes)
    {
        if (!TryCharge(bytes, detailsFloor)) throw new TooLarge();
    }

    private object? Pooled(object value, long keepFree, bool name = false)
    {
        object? found = value is string text ? (objects.TryText(text, out var held) ? held : null) : (objects.TryText((PackedText)value, out var packed) ? packed : null);
        if (found is not null) return found;
        var acquired = pool.TryAcquire(value, keepFree);
        if (acquired is null) return null;
        if (!(name ? TryChargeName(IndexMemory.SlotBytes) : TryCharge(IndexMemory.SlotBytes, keepFree))) { pool.Release([acquired]); return null; }
        objects.Text(acquired);
        return acquired;
    }

    private string Intern(string value) => (string?)Pooled(value, namesFloor, name: true) ?? throw new TooLarge();
    private string InternDetail(string value) => (string?)Pooled(value, detailsFloor) ?? throw new TooLarge();

    private void Abandon()
    {
        pool.Release(objects.Texts);
        objects.Clear();
        budget.Release(taken);
        taken = credited = creditLeft = 0;
    }

    private int Add(string kind, string folder, string? subtype, string? schema, string name, long? modified)
    {
        Charge(IndexMemory.RecordBytes);
        return objects.Add(kind, folder, subtype, schema, name, Date(modified), false);
    }

    internal static DateTime? Date(long? ms) => ms is > 0 and < 253_402_300_800_000 ? DateTime.UnixEpoch.AddMilliseconds(ms.Value) : null;

    /// <summary>The dataset's read, or null when it does not fit; without <paramref name="children"/> no column is kept
    /// (CHILDREN_LEFT_OUT), and without <paramref name="definitions"/> no view or routine text.</summary>
    public DatabaseIndex? Read(string project, string dataset, IReadOnlyList<BigQueryEntry> entries, bool children, bool definitions)
    {
        try
        {
            Intern(dataset);
            Add("bqDataset", "", null, null, dataset, null);
            var detailed = false;
            foreach (var entry in entries)
            {
                var detail = entry.Detail;
                detailed |= detail is not null;
                Intern(entry.Name);
                // Carried details may be an earlier generation's (a table created again): the listing's own facts name the object.
                var current = detail is { Carried: false } ? detail : null;
                var at = Add(entry.Kind, entry.Folder, current?.Subtype ?? entry.Subtype, dataset, entry.Name, current?.Modified ?? entry.Modified ?? entry.Created);
                var signature = detail?.Signature is { } sig ? Clip(sig) : null;
                var partitioning = detail?.Partitioning is { } part ? Clip(part) : null;
                var clustering = detail?.Clustering is { } cluster ? Clip(cluster) : null;
                Charge(BigQueryFacts.ObjectBytes + Strings(signature, partitioning, clustering));
                facts[at] = new(entry.Created, detail is not null, detail?.Rows, detail?.Bytes, partitioning, clustering, signature, ColumnsCut: detail?.ColumnsCut == true, Listed: entry.Modified);
                if (entry.Shards is { } group)
                {
                    Charge(BigQueryFacts.ShardBytes + Strings(group.Prefix, group.First, group.Last));
                    shards[at] = group;
                }
                if (detail is null) continue;
                // A bulk read lacks facts pass 2 keeps, and carried details were not whole: the next build reads the object again
                // rather than reuse it.
                if (detail.Bulk || detail.Carried) facts[at] = facts[at] with { Whole = false };
                if (definitions && detail.Definition is { Length: > 0 } text && !Definition(at, text, detail.DefinitionCut)) facts[at] = facts[at] with { Whole = false };
                if (detail.ColumnsCut) cut++;
                if (!children) continue;
                short ordinal = 0;
                foreach (var column in detail.Columns)
                {
                    InternDetail(column.Path);
                    ChargeDetail(IndexMemory.RecordBytes);
                    var child = objects.Add("bqColumn", "bqColumns", column.Record ? "struct" : null, null, column.Path, null, false);
                    objects.Attach(child, at, false);
                    var typeName = InternDetail(column.Type);
                    if (!types.TryGetValue(typeName, out var type))
                    {
                        // ObjectDetails numbers types in 16 bits: a dataset with more distinct type texts keeps its names only.
                        if (types.Count >= MaxTypes) throw new TooLarge();
                        ChargeDetail(IndexMemory.TypeBytes);
                        type = types[typeName] = objects.Details.AddType(objects.Id(typeName), -1, types.Count, 0, userDefined: true, tableType: false);
                    }
                    ChargeDetail(IndexMemory.TypedBytes);
                    ordinal = ordinal == short.MaxValue ? ordinal : (short)(ordinal + 1);
                    objects.Details.SetTyped(child, type, 0, 0, 0, ordinal, column.Nullable ? TypedFlags.Nullable : TypedFlags.None);
                    if (column.Description is { Length: > 0 } description)
                    {
                        var kept = Clip(description);
                        ChargeDetail(BigQueryFacts.DescriptionBytes + IndexMemory.StringBytes(kept.Length));
                        descriptions[child] = kept;
                    }
                }
            }
            var index = new DatabaseIndex(project, objects.Build(), taken + credited, modules, cut, credited, credited > 0 ? credit : null, pooled: true)
            {
                Dataset = dataset, Facts = new BigQueryFacts(new(facts), new(descriptions), new(shards)), ChildrenLeftOut = !children, DefinitionsLeftOut = !definitions,
                LeftOut = leftOut, Detailed = detailed && children
            };
            objects.Clear();
            taken = credited = creditLeft = 0;
            return index;
        }
        catch (TooLarge)
        {
            Abandon();
            return null;
        }
        catch
        {
            // Whatever else went wrong, the read's charges and pooled names are given back.
            Abandon();
            throw;
        }
    }

    /// <summary>The most distinct column type texts one dataset's read keeps (ObjectDetails' 16-bit type ids, with room to spare).</summary>
    internal const int MaxTypes = 60_000;

    /// <summary>A view's or routine's text, cut at the per-definition limit, pooled while the details' floor is free (counted as cut,
    /// and as left out for memory, otherwise).</summary>
    /// <summary><paramref name="wasCut"/>: the text is an earlier read's, already cut. False when it was left out for the floor.</summary>
    private bool Definition(int at, string text, bool wasCut)
    {
        var longer = wasCut || text.Length > limits.DefinitionChars;
        var kept = text.Length > limits.DefinitionChars ? text[..limits.DefinitionChars] : text;
        // In a build the details' floor is above the names' reserve; a read given no floor still leaves the reserve.
        if (Pooled(DefinitionText.Hold(kept), Math.Max(detailsFloor, limits.NamesReserveBytes)) is not { } copy) { cut++; leftOut++; return false; }
        objects.SetDefinition(at, copy, longer);
        modules++;
        if (longer) cut++;
        return true;
    }

    private static string Clip(string text) => text.Length <= BigQueryIndexLimits.FactChars ? text : text[..(BigQueryIndexLimits.FactChars - 1)] + "…";
    private static long Strings(params string?[] values) => values.Sum(value => value is null ? 0 : IndexMemory.StringBytes(value.Length));
}

/// <summary>How pass 1's listings become index entries, and what an earlier read already knows of them.</summary>
internal static partial class BigQueryEntries
{
    [GeneratedRegex(@"^(?<prefix>.+?)(?<date>\d{8})\z", RegexOptions.CultureInvariant)]
    private static partial Regex Sharded();

    /// <summary>tables.list's type as a kind, folder and subtype (a clone is a TABLE until tables.get says otherwise); null for a type Explorer does not list.</summary>
    public static (string Kind, string Folder, string? Subtype)? TableKind(string? type) => type switch
    {
        "TABLE" or null => ("bqTable", "bqTables", null),
        "SNAPSHOT" => ("bqTable", "bqTables", "snapshot"),
        "VIEW" => ("bqView", "bqViews", null),
        "MATERIALIZED_VIEW" => ("bqMaterializedView", "bqMaterializedViews", null),
        "EXTERNAL" => ("bqExternalTable", "bqExternalTables", null),
        _ => null
    };

    public static string? RoutineSubtype(string? type) => type switch
    {
        "PROCEDURE" => "procedure",
        "SCALAR_FUNCTION" => "scalar",
        "TABLE_VALUED_FUNCTION" => "tableValued",
        "AGGREGATE_FUNCTION" => "aggregate",
        _ => null
    };

    /// <summary>
    /// The dataset's entries in listing order: tables, routines, models. Date-sharded tables (a name ending in a yyyyMMdd date, at least
    /// two with the same prefix, all plain tables) become one entry, their newest shard, carrying the group's prefix, count and range,
    /// as BigQuery Studio groups them. Names a rule refuses are left out.
    /// </summary>
    public static List<BigQueryEntry> FromListing(BigQueryListing listing)
    {
        var tables = new List<(TableList.TablesData Item, string Name, (string Kind, string Folder, string? Subtype) Kind)>();
        foreach (var item in listing.Tables)
            if (item.TableReference?.TableId is { } name && Varia.Backend.BigQuery.BqNames.IsTable(name) && TableKind(item.Type) is { } kind) tables.Add((item, name, kind));
        var groups = new Dictionary<string, List<(string Name, string Date, long Created)>>(StringComparer.Ordinal);
        foreach (var (item, name, kind) in tables)
            if (kind is { Kind: "bqTable", Subtype: null } && Sharded().Match(name) is { Success: true } match && IsDate(match.Groups["date"].Value))
            {
                var prefix = match.Groups["prefix"].Value;
                if (!groups.TryGetValue(prefix, out var list)) groups[prefix] = list = [];
                list.Add((name, match.Groups["date"].Value, item.CreationTime ?? 0));
            }
        var grouped = groups.Where(pair => pair.Value.Count >= 2).ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);
        var member = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (prefix, list) in grouped)
            foreach (var shard in list) member[shard.Name] = prefix;
        var entries = new List<BigQueryEntry>();
        var placed = new HashSet<string>(StringComparer.Ordinal);
        foreach (var (item, name, kind) in tables)
        {
            if (member.TryGetValue(name, out var prefix))
            {
                if (!placed.Add(prefix)) continue;
                var list = grouped[prefix];
                var newest = list.MaxBy(shard => shard.Date, StringComparer.Ordinal);
                var first = list.MinBy(shard => shard.Date, StringComparer.Ordinal).Date;
                entries.Add(new(kind.Kind, kind.Folder, null, newest.Name, newest.Created, null, Shards: new(prefix, list.Count, first, newest.Date)));
                continue;
            }
            entries.Add(new(kind.Kind, kind.Folder, kind.Subtype, name, item.CreationTime ?? 0, null));
        }
        foreach (var routine in listing.Routines)
            if (routine.RoutineReference?.RoutineId is { } name && Varia.Backend.BigQuery.BqNames.IsRoutine(name))
                entries.Add(new("bqRoutine", "bqRoutines", RoutineSubtype(routine.RoutineType), name, routine.CreationTime ?? 0, routine.LastModifiedTime));
        foreach (var model in listing.Models)
            if (model.ModelReference?.ModelId is { } name && Varia.Backend.BigQuery.BqNames.IsModel(name))
                entries.Add(new("bqModel", "bqModels", null, name, model.CreationTime ?? 0, model.LastModifiedTime));
        return entries;
    }

    private static bool IsDate(string text) => DateTime.TryParseExact(text, "yyyyMMdd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var date) && date.Year >= 1900;

    /// <summary>Whether pass 2 reads the object: tables, views, materialized views, external tables and routines; models have nothing it keeps.</summary>
    public static bool HasDetails(BigQueryEntry entry) => entry.Kind != "bqModel";

    /// <summary>What an earlier read of the dataset knows, by kind and name, for the objects it read details of whole: nothing from a
    /// read that left its columns out, or its text when this build keeps <paramref name="definitions"/>, which pass 2 then reads again.
    /// With <paramref name="carry"/>, also the details that were not whole (a bulk read's, one whose text was left out, a read
    /// without the definitions this build wants), marked <see cref="BigQueryDetail.Carried"/>: pass 1 holds them until pass 2
    /// has read the object again, so the dataset keeps the memory its columns hold between the two passes.</summary>
    public static Dictionary<(string Kind, string Name), (long Created, long? Modified, BigQueryDetail Detail)> Known(DatabaseIndex? read, bool definitions, bool carry = false)
    {
        var known = new Dictionary<(string, string), (long, long?, BigQueryDetail)>();
        if (read?.Facts is not { } facts || read.ChildrenLeftOut) return known;
        var bare = definitions && read.DefinitionsLeftOut;
        if (bare && !carry) return known;
        var table = read.Table;
        var columns = new Dictionary<int, List<BigQueryColumn>>();
        for (var at = 0; at < table.Count; at++)
        {
            var parent = table.Parent(at);
            if (parent < 0) continue;
            if (!columns.TryGetValue(parent, out var list)) columns[parent] = list = [];
            list.Add(new(table.Name(at), table.Subtype(at) == "struct", table.Typed(at)?.TypeName ?? "?", table.Typed(at) is { } typed && (typed.Flags & TypedFlags.Nullable) != 0, facts.Description(at)));
        }
        for (var at = 0; at < table.Count; at++)
        {
            if (table.Parent(at) >= 0 || facts.Of(at) is not { Detailed: true } fact || !fact.Whole && !carry) continue;
            var modified = table.Modified(at) is { } date ? (long)(date - DateTime.UnixEpoch).TotalMilliseconds : (long?)null;
            var subtype = table.Subtype(at) == "clone" ? "clone" : null;
            known[(table.Kind(at), table.Name(at))] = (fact.Created, fact.Listed, new BigQueryDetail(subtype, modified, table.Definition(at), columns.GetValueOrDefault(at) ?? [],
                fact.Rows, fact.Bytes, fact.Partitioning, fact.Clustering, fact.Signature, fact.ColumnsCut, table.DefinitionCut(at), Carried: bare || !fact.Whole));
        }
        return known;
    }

    /// <summary>The objects an earlier read holds details of, by kind and name: what a read that replaces it may keep when the
    /// details of anything new do not fit.</summary>
    public static HashSet<(string Kind, string Name)> Detailed(DatabaseIndex? read)
    {
        var detailed = new HashSet<(string, string)>();
        if (read?.Facts is not { } facts || read.ChildrenLeftOut) return detailed;
        var table = read.Table;
        for (var at = 0; at < table.Count; at++)
            if (table.Parent(at) < 0 && facts.Of(at) is { Detailed: true }) detailed.Add((table.Kind(at), table.Name(at)));
        return detailed;
    }

    /// <summary>A listed object with the details an earlier read knows of it, when it has the same creation time and (for routines and
    /// models) last change; otherwise the object as listed.</summary>
    public static BigQueryEntry Reuse(Dictionary<(string Kind, string Name), (long Created, long? Modified, BigQueryDetail Detail)> known, BigQueryEntry item) =>
        known.TryGetValue((item.Kind, item.Name), out var earlier) && earlier.Created == item.Created && (item.Modified is null || item.Modified == earlier.Modified)
            ? item with { Detail = earlier.Detail } : item;

    /// <summary>pass 2's tables.get as a detail: columns flattened depth first (STRUCT fields below their column), layout and size.</summary>
    public static BigQueryDetail FromTable(Table table)
    {
        var columns = new List<BigQueryColumn>();
        var cut = false;
        void Walk(IList<TableFieldSchema>? fields, string? path, int depth)
        {
            foreach (var field in fields ?? [])
            {
                if (columns.Count >= BigQueryIndexLimits.Columns) { cut = true; return; }
                if (!Varia.Backend.BigQuery.BqNames.IsColumn(field.Name)) continue;
                var full = path is null ? field.Name : path + "." + field.Name;
                if (!Varia.Backend.BigQuery.BqNames.IsFieldPath(full)) continue;
                var record = field.Type is "RECORD" or "STRUCT";
                columns.Add(new(full, record, TypeText(field), field.Mode != "REQUIRED", field.Description));
                if (record && depth < Varia.Backend.BigQuery.BqNames.FieldDepth) Walk(field.Fields, full, depth + 1);
            }
        }
        Walk(table.Schema?.Fields, null, 1);
        var definition = table.View?.Query ?? table.MaterializedView?.Query;
        var partitioning = table.TimePartitioning is { } time ? (time.Type ?? "DAY") + " on " + (time.Field ?? "_PARTITIONTIME")
            : table.RangePartitioning is { } range ? "integer range on " + range.Field : null;
        var clustering = table.Clustering?.Fields is { Count: > 0 } fields ? string.Join(", ", fields) : null;
        var subtype = table.Type == "TABLE" && table.CloneDefinition is not null ? "clone" : table.Type == "SNAPSHOT" ? "snapshot" : null;
        return new(subtype, (long?)table.LastModifiedTime, definition, columns, table.NumRows is { } rows ? (long)rows : null, table.NumBytes, partitioning, clustering, ColumnsCut: cut);
    }

    /// <summary>routines.get as a detail: its body and its signature (arguments and return type).</summary>
    public static BigQueryDetail FromRoutine(Routine routine)
    {
        var arguments = string.Join(", ", (routine.Arguments ?? []).Select(argument => (argument.Mode is { Length: > 0 } mode && mode != "IN" ? mode + " " : "") + argument.Name
            + (argument.DataType is { } type ? " " + TypeText(type) : argument.ArgumentKind == "ANY_TYPE" ? " ANY TYPE" : "")));
        var returns = routine.ReturnType is { } result ? " RETURNS " + TypeText(result) : routine.ReturnTableType is not null ? " RETURNS TABLE" : "";
        return new(RoutineSubtype(routine.RoutineType), routine.LastModifiedTime, routine.DefinitionBody, [], Signature: "(" + arguments + ")" + returns);
    }

    /// <summary>A column's type as search shows it: INT64, STRING(10), NUMERIC(10, 2), ARRAY&lt;STRING&gt;, STRUCT, ARRAY&lt;STRUCT&gt;.</summary>
    public static string TypeText(TableFieldSchema field)
    {
        var type = field.Type switch { "RECORD" => "STRUCT", "INTEGER" => "INT64", "FLOAT" => "FLOAT64", "BOOLEAN" => "BOOL", null => "?", var other => other };
        if (field.MaxLength is { } length && type is "STRING" or "BYTES") type += "(" + length.ToString(CultureInfo.InvariantCulture) + ")";
        else if (field.Precision is { } precision && type is "NUMERIC" or "BIGNUMERIC")
            type += "(" + precision.ToString(CultureInfo.InvariantCulture) + (field.Scale is { } scale ? ", " + scale.ToString(CultureInfo.InvariantCulture) : "") + ")";
        return field.Mode == "REPEATED" ? "ARRAY<" + type + ">" : type;
    }

    /// <summary>A routine argument's or return type: its kind, ARRAY&lt;…&gt; and STRUCT&lt;…&gt; spelled out to one level.</summary>
    public static string TypeText(StandardSqlDataType type) => type.TypeKind switch
    {
        "ARRAY" => "ARRAY<" + (type.ArrayElementType is { } element ? TypeText(element) : "?") + ">",
        "STRUCT" => "STRUCT<" + string.Join(", ", (type.StructType?.Fields ?? []).Select(field => field.Name + " " + (field.Type is { } inner ? inner.TypeKind ?? "?" : "?"))) + ">",
        null => "?",
        var kind => kind
    };
}
