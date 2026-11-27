using System.Data;
using System.Globalization;
using System.Text;
using Varia.Backend.Explorer;
using Varia.Backend.Search;

namespace Varia.Backend.Tests;

/// <summary>
/// The SQL Server reload's offline parts (docs/object-search.md, Saved index): the sync state a file keeps (<see cref="SqlSync"/>),
/// whose empty, foreign or damaged bytes say nothing; the fingerprint's digest, the same whatever the culture or time zone; the
/// saved listing (<see cref="SqlListing"/>); what a listing diff reads again (<see cref="SqlReloadPlan"/>); and, on a model
/// database read through fake batches shaped as <see cref="ObjectSearchSql.Batch"/>'s, that a selective re-read of what changed,
/// merged with the saved read, holds exactly what a whole read of the changed database holds.
/// </summary>
internal static class SqlReloadChecks
{
    private static readonly DateTime At = new(2026, 11, 1, 8, 30, 0, DateTimeKind.Unspecified);
    private static readonly DateTime Later = At.AddMinutes(5);

    public static async Task RunAsync(Action<bool, string> check)
    {
        Syncs(check);
        Digests(check);
        Listings(check);
        Plans(check);
        Lint(check);
        await Merges(check);
    }

    private static SqlSync Sample(bool definitions = true, bool children = true) =>
        new(definitions, children, 7, At.Ticks, Guid.Parse("0f8fad5b-d9cb-469f-a165-70867728950e"), 1234, [.. Enumerable.Range(0, SqlSync.DigestBytes).Select(at => (byte)(at * 13))]);

    private static void Syncs(Action<bool, string> check)
    {
        var sample = Sample();
        var bytes = sample.ToBytes();
        var back = SqlSync.From(bytes);
        check(bytes.Length == SqlSync.Bytes && back is { } read && read.Unchanged(sample) && read.Definitions && read.Children
            && SqlSync.From(Sample(definitions: false, children: false).ToBytes()) is { Definitions: false, Children: false },
            "a SQL Server file's sync state round-trips, with the mode it was read in");
        // A file saved before fingerprints (PR 3's empty Sync), BigQuery's 30 bytes, another version, unknown flags, a short read.
        var foreign = new BigQuerySync(false, 0, 0, 0).ToBytes();
        var version = (byte[])bytes.Clone();
        version[0] = 2;
        var flags = (byte[])bytes.Clone();
        flags[1] |= 4;
        check(SqlSync.From([]) is null && SqlSync.From(foreign) is null && SqlSync.From(version) is null && SqlSync.From(flags) is null && SqlSync.From(bytes.AsSpan(0, SqlSync.Bytes - 1)) is null
            && SqlSync.From([.. bytes, 0]) is null, "an empty, foreign, newer, unknown-flagged or cut sync state says nothing (the database is read whole)");
        var other = sample with { Digest = [.. sample.Digest.Select(value => (byte)(value ^ 1))] };
        check(sample.SameDatabase(other) && !sample.Unchanged(other), "a different digest of the same database is a change, not another database");
        check(!sample.SameDatabase(sample with { DatabaseId = 8 }) && !sample.SameDatabase(sample with { Created = sample.Created + 1 })
            && !sample.SameDatabase(sample with { Broker = Guid.Empty }) && !sample.SameDatabase(sample with { Collation = 1235 }),
            "a database re-created or restored over (another id, creation time or broker GUID) or with another collation is another database");
    }

    private static void Digests(Action<bool, string> check)
    {
        object?[] values = [12L, At, 77, null, 3L, -5, 0L, 0, 1L, Later, 9, 0L, null];
        var digest = SqlFingerprint.DigestOf(values);
        var culture = CultureInfo.CurrentCulture;
        byte[] turkish;
        try
        {
            CultureInfo.CurrentCulture = new CultureInfo("tr-TR");
            turkish = SqlFingerprint.DigestOf(values);
        }
        finally { CultureInfo.CurrentCulture = culture; }
        check(digest.Length == SqlSync.DigestBytes && digest.SequenceEqual(turkish)
            && Convert.ToHexString(digest) == Convert.ToHexString(SqlFingerprint.DigestOf([12L, new DateTime(At.Ticks, DateTimeKind.Utc), 77, null, 3L, -5, 0L, 0, 1L, Later, 9, 0L, null])),
            "the fingerprint's digest is the same under any culture and whatever a date's kind (its ticks only)");
        check(!SqlFingerprint.DigestOf([1L]).SequenceEqual(SqlFingerprint.DigestOf([1])) && !SqlFingerprint.DigestOf([null]).SequenceEqual(SqlFingerprint.DigestOf([0L]))
            && !SqlFingerprint.DigestOf([1L, 2L]).SequenceEqual(SqlFingerprint.DigestOf([2L, 1L])),
            "the digest tells a count from a checksum, a null from zero, and one column's value from another's");
    }

    private static void Listings(Action<bool, string> check)
    {
        SqlListingRow[] rows = [new(30, 10, At.Ticks, -4, 2), new(10, 0, At.Ticks, 99, 0), new(5, 10, Later.Ticks, 1, -1)];
        var bytes = SqlListing.ToBytes(rows)!;
        var back = SqlListing.From(bytes, 3);
        check(back is { Count: 3 } && rows.All(row => back[row.Id] == row), "a listing round-trips, each row with its entry");
        var duplicate = SqlListing.ToBytes([.. rows, rows[0]])!;
        var version = (byte[])bytes.Clone();
        version[0] = 9;
        check(SqlListing.From(bytes, 2) is null && SqlListing.From(duplicate, 3) is null && SqlListing.From(version, 3) is null && SqlListing.From(bytes.AsSpan(0, bytes.Length - 1), 3) is null
            && SqlListing.From([], 3) is null, "a listing naming an entry past its table, repeating an id, of another version or cut short is refused");
    }

    private static Dictionary<int, SqlListingRow> Saved(params SqlListingRow[] rows) => rows.ToDictionary(row => row.Id);

    private static void Plans(Action<bool, string> check)
    {
        SqlListingRow Row(int id, int parent = 0, DateTime? modified = null, int checksum = 1) => new(id, parent, (modified ?? At).Ticks, checksum, -1);
        SqlListingRow[] before = [Row(10), Row(30, 10), Row(31, 10), Row(20), Row(40), Row(41)];
        var saved = Saved(before);
        var same = SqlReloadPlan.Of(saved, before);
        check(same.Units.Count == 0 && same.Reread.Count == 0 && same.Changed == 0 && before.All(row => same.Keeps(row.Id)), "an unchanged listing reads nothing again and keeps every object");
        var altered = SqlReloadPlan.Of(saved, [Row(10), Row(30, 10), Row(31, 10), Row(20), Row(40, modified: Later), Row(41)]);
        check(altered.Units.SetEquals([40]) && altered.Reread.SetEquals([40]) && !altered.Keeps(40) && altered.Keeps(10), "an altered procedure is read again alone");
        var trigger = SqlReloadPlan.Of(saved, [Row(10), Row(30, 10, Later), Row(31, 10), Row(20), Row(40), Row(41)]);
        check(trigger.Units.SetEquals([10]) && trigger.Reread.SetEquals([10, 30, 31]) && trigger.Keeps(20), "a changed child reads its parent again with every child it has now");
        var dropped = SqlReloadPlan.Of(saved, [Row(10), Row(30, 10), Row(20), Row(40)]);
        check(dropped.Units.SetEquals([10, 41]) && dropped.Reread.SetEquals([10, 30, 41]) && !dropped.Keeps(31) && !dropped.Keeps(41) && dropped.Changed == 2,
            "a dropped child reads its parent again, and a dropped object is not kept");
        var added = SqlReloadPlan.Of(saved, [.. before, Row(50), Row(51, 50)]);
        check(added.Units.SetEquals([50]) && added.Reread.SetEquals([50, 51]), "a new table is read with its children");
        var renamed = SqlReloadPlan.Of(saved, [Row(10), Row(30, 10), Row(31, 10), Row(20, checksum: 2), Row(40), Row(41)]);
        check(renamed.Units.SetEquals([20]), "a rename or schema transfer (the row's checksum) is a change even where the date stays");
        check(new SqlReloadPlan([], [.. Enumerable.Range(1, SqlReloadPlan.MinShare)], [], 0).Worth(10) && !new SqlReloadPlan([], [.. Enumerable.Range(1, SqlReloadPlan.MinShare + 1)], [], 0).Worth(1000)
            && new SqlReloadPlan([], [.. Enumerable.Range(1, 2500)], [], 0).Worth(10_000) && !new SqlReloadPlan([], [.. Enumerable.Range(1, SqlReloadPlan.MostReread + 1)], [], 0).Worth(1_000_000),
            "a selective read pays only for up to a quarter of the objects (any share of a small database) and at most its id limit");
    }

    private static void Lint(Action<bool, string> check)
    {
        var render = new SqlRender(ExplorerCatalog.MaxBand);
        var whole = ObjectSearchSql.Batch(render, true);
        var only = ObjectSearchSql.Batch(render, true, only: true);
        check(ObjectSearchSql.Lint().Count == 0 && only.Contains("OPENJSON(@ids)", StringComparison.Ordinal) && !whole.Contains("@ids", StringComparison.Ordinal)
            && whole.Contains("WHERE st.auto_created = 0", StringComparison.Ordinal) && only.Contains("WHERE st.auto_created = 0", StringComparison.Ordinal)
            && ObjectSearchSql.Fingerprint(render).Contains("DB_ID()", StringComparison.Ordinal) && !ObjectSearchSql.Fingerprint(render).Contains("@", StringComparison.Ordinal),
            "the fingerprint, listing and selective batch pass the index's lint; no batch reads auto-created statistics; only the selective batch names its ids");
    }

    // ---- A model database read through fake batches ----

    private sealed record Obj(int Id, string Name, string Type, int Parent = 0, DateTime? Modified = null, byte Variant = 0, int? Current = null, string? Definition = null, string Schema = "dbo")
    {
        public int Checksum => Fnv(Name + "\u0001" + Schema + "\u0001" + Type);
    }

    private sealed class Model
    {
        public List<Obj> Objects = [];
        /// <summary>Columns: owner, name, column_id, user_type_id.</summary>
        public List<(int Owner, string Name, int Column, int Type)> Columns = [];
        public List<(int Owner, string Name, byte Type, int Index)> Indexes = [];
        public List<(int Owner, string Name)> Stats = [];
        public List<(int Owner, string Name, int Parameter, int Type)> Parameters = [];
        public List<(int Owner, int Index, int Column)> IndexColumns = [];
        /// <summary>Key constraints: key id, table, index id.</summary>
        public List<(int Key, int Table, int Index)> KeyIndexes = [];
        /// <summary>Foreign key columns: key, column, referenced table, referenced column.</summary>
        public List<(int Key, int Column, int Referenced, int Other)> ForeignKeys = [];

        public Model Clone() => new()
        {
            Objects = [.. Objects], Columns = [.. Columns], Indexes = [.. Indexes], Stats = [.. Stats], Parameters = [.. Parameters], IndexColumns = [.. IndexColumns],
            KeyIndexes = [.. KeyIndexes], ForeignKeys = [.. ForeignKeys]
        };

        public List<SqlListingRow> Listing() => [.. Objects.OrderBy(item => item.Id).Select(item => new SqlListingRow(item.Id, item.Parent, (item.Modified ?? At).Ticks, item.Checksum, -1))];
    }

    private const int TableType = 900;

    private static int Fnv(string text)
    {
        var hash = 2166136261u;
        foreach (var value in text) hash = (hash ^ value) * 16777619u;
        return unchecked((int)hash);
    }

    private static DataTable Rows((string Name, Type Type)[] columns, IEnumerable<object?[]> rows)
    {
        var table = new DataTable();
        foreach (var (name, type) in columns) table.Columns.Add(name, type);
        foreach (var row in rows) table.Rows.Add([.. row.Select(value => value ?? DBNull.Value)]);
        return table;
    }

    /// <summary>The model as <see cref="ObjectSearchSql.Batch"/> answers it (with definitions and children), or with
    /// <paramref name="only"/> as its selective form does: only those ids' rows, their children's, and the table type's.</summary>
    private static SearchCostChecks.Batch Batch(Model model, HashSet<int>? only = null)
    {
        bool Keeps(int id) => only is null || only.Contains(id) || id == TableType;
        var parents = model.Objects.ToDictionary(item => item.Id, item => item.Parent);
        var sets = new List<DataTable>
        {
            Rows([("id", typeof(int)), ("schema", typeof(string)), ("name", typeof(string)), ("type", typeof(string)), ("modified", typeof(DateTime)), ("parent", typeof(int)),
                ("system", typeof(bool)), ("variant", typeof(byte)), ("current", typeof(int)), ("checksum", typeof(int))],
                model.Objects.Where(item => Keeps(item.Id) || item.Parent == TableType).OrderBy(item => item.Id)
                    .Select(item => new object?[] { item.Id, item.Schema, item.Name, item.Type, item.Modified ?? At, item.Parent, false, item.Variant, item.Current, item.Checksum })),
            Rows([("id", typeof(int)), ("schema", typeof(string)), ("name", typeof(string)), ("table", typeof(bool)), ("assembly", typeof(bool)), ("object", typeof(int))],
                [[257, "dbo", "List", true, false, TableType], [258, "dbo", "Phone", false, false, null]]),
            Rows([("code", typeof(string)), ("schema", typeof(string)), ("name", typeof(string)), ("modified", typeof(DateTime)), ("system", typeof(bool))],
                [["SC", null, "sales", null, false], ["US", null, "dbo", At, true]]),
            Rows([("id", typeof(int)), ("name", typeof(string)), ("modified", typeof(DateTime)), ("system", typeof(bool))], [[50, "ddl_audit", At, false]]),
            Rows([("name", typeof(string)), ("modified", typeof(DateTime)), ("text", typeof(string))], [["pg_orders", At, "SELECT 1"]]),
            Rows([("id", typeof(int)), ("schema", typeof(string)), ("name", typeof(string)), ("system", typeof(byte)), ("user", typeof(bool)), ("table", typeof(bool))],
                [.. SearchChecks.SystemTypes, [257, "dbo", "List", (byte)243, true, true], [258, "dbo", "Phone", (byte)231, true, false]]),
            Rows([("id", typeof(int)), ("name", typeof(string)), ("column", typeof(int)), ("type", typeof(int)), ("length", typeof(short)), ("precision", typeof(byte)), ("scale", typeof(byte)),
                ("nullable", typeof(bool)), ("identity", typeof(bool)), ("computed", typeof(bool)), ("default", typeof(bool)), ("dimensions", typeof(int)), ("expression", typeof(string))],
                model.Columns.Where(column => Keeps(column.Owner)).OrderBy(column => column.Owner).ThenBy(column => column.Column)
                    .Select(column => new object?[] { column.Owner, column.Name, column.Column, column.Type, (short)4, (byte)10, (byte)0, true, false, false, false, null, null })),
            Rows([("id", typeof(int)), ("name", typeof(string)), ("type", typeof(byte)), ("index", typeof(int))],
                model.Indexes.Where(index => Keeps(index.Owner)).OrderBy(index => index.Owner).ThenBy(index => index.Index).Select(index => new object?[] { index.Owner, index.Name, index.Type, index.Index })),
            Rows([("id", typeof(int)), ("name", typeof(string))], model.Stats.Where(stat => only is null || only.Contains(stat.Owner)).OrderBy(stat => stat.Owner).Select(stat => new object?[] { stat.Owner, stat.Name })),
            Rows([("id", typeof(int)), ("name", typeof(string)), ("output", typeof(bool)), ("parameter", typeof(int)), ("type", typeof(int)), ("length", typeof(short)),
                ("precision", typeof(byte)), ("scale", typeof(byte)), ("readonly", typeof(bool)), ("dimensions", typeof(int))],
                model.Parameters.Where(parameter => only is null || only.Contains(parameter.Owner)).OrderBy(parameter => parameter.Owner).ThenBy(parameter => parameter.Parameter)
                    .Select(parameter => new object?[] { parameter.Owner, parameter.Name, false, parameter.Parameter, parameter.Type, (short)4, (byte)10, (byte)0, false, null })),
            Rows([("id", typeof(int)), ("index", typeof(int)), ("column", typeof(int)), ("descending", typeof(bool)), ("included", typeof(bool))],
                model.IndexColumns.Where(column => Keeps(column.Owner)).OrderBy(column => column.Owner).ThenBy(column => column.Index).Select(column => new object?[] { column.Owner, column.Index, column.Column, false, false })),
            Rows([("id", typeof(int)), ("parent", typeof(int)), ("index", typeof(int))],
                model.KeyIndexes.Where(key => Keeps(key.Table)).OrderBy(key => key.Key).Select(key => new object?[] { key.Key, key.Table, key.Index })),
            Rows([("id", typeof(int)), ("column", typeof(int)), ("referenced", typeof(int)), ("other", typeof(int))],
                model.ForeignKeys.Where(key => only is null || only.Contains(parents.GetValueOrDefault(key.Key))).OrderBy(key => key.Key)
                    .Select(key => new object?[] { key.Key, key.Column, key.Referenced, key.Other })),
            Rows([("id", typeof(int)), ("text", typeof(string))],
                model.Objects.Where(item => item.Definition is not null && (only is null || only.Contains(item.Id) || item.Parent != 0 && (only.Contains(item.Parent) || item.Parent == TableType)))
                    .OrderBy(item => item.Id).Select(item => new object?[] { item.Id, item.Definition })),
            Rows([("cased", typeof(bool)), ("dotted", typeof(bool))], [[false, false]]),
        };
        return new SearchCostChecks.Batch([.. sets]);
    }

    private static Model Start()
    {
        var model = new Model();
        model.Objects.AddRange([
            new(10, "Orders", "U"), new(5, "trg_orders", "TR", 10, Definition: "CREATE TRIGGER trg_orders ON dbo.Orders AFTER INSERT AS SELECT 1"),
            new(30, "pk_orders", "PK", 10), new(31, "fk_orders_customers", "F", 10), new(35, "ck_orders_total", "C", 10, Definition: "([total]>(0))"),
            new(20, "Customers", "U"), new(32, "pk_customers", "PK", 20),
            new(70, "Lines", "U"), new(71, "fk_lines_orders", "F", 70),
            new(12, "Prices", "U"), new(11, "Prices_History", "U", Variant: 6, Current: 12),
            new(40, "usp_get", "P", Definition: "CREATE PROCEDURE dbo.usp_get @id int AS SELECT @id"),
            new(44, "usp_gone", "P", Definition: "CREATE PROCEDURE dbo.usp_gone AS SELECT 2"),
            new(45, "vw_orders", "V", Definition: "CREATE VIEW dbo.vw_orders AS SELECT 1 AS one"),
            new(46, "usp_old_name", "P", Definition: "CREATE PROCEDURE dbo.usp_old_name AS SELECT 3"),
            new(41, "fn_total", "FN", Definition: "CREATE FUNCTION dbo.fn_total() RETURNS int AS BEGIN RETURN 1 END"),
            new(901, "pk_list", "PK", TableType),
        ]);
        model.Columns.AddRange([(10, "id", 1, 56), (10, "customer_id", 2, 56), (10, "phone", 3, 258), (20, "id", 1, 56), (70, "id", 1, 56), (70, "order_id", 2, 56),
            (12, "rate", 1, 56), (11, "rate", 1, 56), (45, "one", 1, 56), (TableType, "value", 1, 56)]);
        model.Indexes.AddRange([(10, "pk_orders", 1, 1), (10, "ix_orders_customer", 2, 2), (20, "pk_customers", 1, 1), (TableType, "PK__List", 1, 1)]);
        model.Stats.AddRange([(10, "st_orders_customer"), (20, "pk_customers")]);
        model.Parameters.AddRange([(40, "@id", 1, 56), (41, "", 0, 56), (40, "@list", 2, 257)]);
        model.IndexColumns.AddRange([(10, 1, 1), (10, 2, 2), (20, 1, 1), (TableType, 1, 1)]);
        model.KeyIndexes.AddRange([(30, 10, 1), (32, 20, 1), (901, TableType, 1)]);
        model.ForeignKeys.AddRange([(31, 2, 20, 1), (71, 2, 10, 1)]);
        return model;
    }

    /// <summary>The model after DDL: a view altered, a procedure dropped and one renamed, a new table with a key, a column added to a
    /// table (whose foreign key references a kept table, and which a kept table's foreign key references), and the table a kept
    /// history table is shown below altered.</summary>
    private static Model Changed(Model start)
    {
        var model = start.Clone();
        Obj Find(int id) => model.Objects.Single(item => item.Id == id);
        void Swap(int id, Obj with) => model.Objects[model.Objects.IndexOf(Find(id))] = with;
        Swap(45, Find(45) with { Modified = Later, Definition = "CREATE VIEW dbo.vw_orders AS SELECT 2 AS two" });
        model.Columns.Remove((45, "one", 1, 56));
        model.Columns.Add((45, "two", 1, 56));
        model.Objects.Remove(Find(44));
        Swap(46, Find(46) with { Name = "usp_new_name" });
        model.Objects.AddRange([new(80, "Shipments", "U", Modified: Later), new(81, "pk_shipments", "PK", 80, Modified: Later)]);
        model.Columns.Add((80, "id", 1, 56));
        model.Indexes.Add((80, "pk_shipments", 1, 1));
        model.IndexColumns.Add((80, 1, 1));
        model.KeyIndexes.Add((81, 80, 1));
        Swap(10, Find(10) with { Modified = Later });
        model.Columns.Add((10, "note", 4, 231));
        Swap(12, Find(12) with { Modified = Later });
        return model;
    }

    /// <summary>What a table holds, whatever order its entries are in: each entry by its labels, with its parent's, its Via's and a
    /// foreign key's table by label rather than by entry.</summary>
    private static string Content(DatabaseIndex read)
    {
        var table = read.Table;
        string Label(int at) => at < 0 ? "-" : table.Kind(at) + ":" + table.Label(at);
        var lines = new List<string>();
        for (var at = 0; at < table.Count; at++)
        {
            var row = table.Row(at);
            lines.Add(string.Join("|", Label(at), row.Folder, row.Subtype, row.System, row.Modified?.Ticks, Label(table.Parent(at)), Label(table.Via(at)),
                row.Definition is { } definition ? definition.Length + ":" + Fnv(definition) : "-", row.DefinitionCut,
                table.Typed(at) is { } typed ? typed.TypeText + "/" + typed.Ordinal + "/" + typed.Flags : "-",
                string.Join(",", table.KeyColumns(at).Select(column => column.Column + ":" + column.Referenced + ":" + column.Flags)), Label(table.Referenced(at))));
        }
        lines.Sort(StringComparer.Ordinal);
        return $"{read.Modules}|{read.Cut}|{read.LeftOut}|{read.CaseSensitive}|{read.DottedI}|{table.Count}\n" + string.Join("\n", lines);
    }

    /// <summary>A read's listing by id, each row with its entry's label in place of the entry.</summary>
    private static string ListingContent(DatabaseIndex read, byte[]? listing)
    {
        if (listing is null || SqlListing.From(listing, read.Table.Count) is not { } rows) return "none";
        return string.Join("\n", rows.Values.OrderBy(row => row.Id).Select(row => row.Id + "|" + row.Parent + "|" + row.Modified + "|" + row.Checksum + "|"
            + (row.Entry < 0 ? "-" : read.Table.Kind(row.Entry) + ":" + read.Table.Label(row.Entry))));
    }

    private static async Task Merges(Action<bool, string> check)
    {
        var world = new IndexFileChecks.World();
        var start = Start();
        var first = new DatabaseReader("Sales", world.Limits, world.Pool);
        var saved = (await first.ReadAsync(Batch(start), true, CancellationToken.None))!;
        var savedListing = first.Listing;
        check(savedListing is not null && SqlListing.From(savedListing, saved.Table.Count) is { } rows && rows.Count == start.Objects.Count
            && rows[10].Entry >= 0 && saved.Table.Name(rows[10].Entry) == "Orders" && rows[30].Entry >= 0 && saved.Table.Name(rows[30].Entry) == "pk_orders"
            && rows[901].Entry >= 0 && saved.Table.Kind(saved.Table.Parent(rows[901].Entry)) == "tableType",
            "a whole read lists every sys.objects row it read, each with the entry it is in the table");
        check(new DatabaseReader("Sales", world.Limits, world.Pool) is var plain && await plain.ReadAsync(IndexFileChecks.DatabaseBatch(true, true), true, CancellationToken.None) is { } older
            && plain.Listing is null && older.Table.Count > 0 && ReleaseRead(world, older),
            "a batch of the earlier shape (no checksum column) reads as before and keeps no listing");

        var changed = Changed(start);
        var whole = new DatabaseReader("Sales", world.Limits, world.Pool);
        var expected = (await whole.ReadAsync(Batch(changed), true, CancellationToken.None))!;
        var listing = SqlListing.From(savedListing!, saved.Table.Count)!;
        var plan = SqlReloadPlan.Of(listing, changed.Listing());
        check(plan.Units.SetEquals([10, 12, 44, 45, 46, 80]) && plan.Reread.SetEquals([10, 5, 30, 31, 35, 12, 44, 45, 46, 80, 81]),
            "the diff reads again the altered view, the renamed, new and dropped objects, and each altered table with its children: " + string.Join(",", plan.Reread.Order()));
        var merge = new DatabaseReader("Sales", world.Limits, world.Pool, saved);
        var seeded = merge.Seed(saved, listing, plan.Keeps);
        var merged = await merge.ReadAsync(Batch(changed, plan.Reread), true, CancellationToken.None);
        check(seeded && merged is not null && Content(merged) == Content(expected),
            "a selective re-read merged with the saved read holds exactly what a whole read of the changed database holds\n" + (merged is null ? "none" : Diff(Content(merged), Content(expected))));
        check(merged is not null && ListingContent(merged, merge.Listing) == ListingContent(expected, whole.Listing),
            "and its listing is the whole read's, entry for entry");
        var batchRows = changed.Objects.Count(item => plan.Reread.Contains(item.Id) || item.Parent == TableType);
        check(merge.Listed == batchRows && batchRows < changed.Objects.Count,
            "the batch read only the changed objects' rows (" + merge.Listed + " of " + changed.Objects.Count + ")");
        world.Connection.Abandon(expected);
        if (merged is not null)
        {
            // The merged read replaces the saved one as a reload holds it: its share moves over, nothing is lost or counted twice.
            world.Connection.Put(merged);
            world.Connection.Abandon(saved);
            // Alone in a world of its own, the whole read's names cost the pool what the merged read's do: nothing is counted twice.
            var alone = new IndexFileChecks.World();
            var single = (await new DatabaseReader("Sales", alone.Limits, alone.Pool).ReadAsync(Batch(changed), true, CancellationToken.None))!;
            var texts = alone.Budget.Used - single.Bytes;
            alone.Connection.Abandon(single);
            check(world.Budget.Used - merged.Bytes == texts && alone.Empty,
                "the merged read is charged once, the saved read's share given back (" + (world.Budget.Used - merged.Bytes) + " bytes of texts against " + texts + ")");
            world.Connection.KeepWhere(_ => false, gone: false);
        }
        else world.Connection.Abandon(saved);
        check(world.Empty, "every read given back leaves the budget and the pool empty");

        // Too little memory to copy what is kept: the seed gives back what it took and the database is reported too large.
        var tight = new IndexFileChecks.World(new ObjectIndexLimits { MemoryBytes = 1 << 20, NamesReserveBytes = 0 });
        var small = (await new DatabaseReader("Sales", tight.Limits, tight.Pool).ReadAsync(Batch(start), true, CancellationToken.None))!;
        var used = tight.Budget.Used;
        tight.Budget.Force(tight.Budget.Limit);
        var refused = new DatabaseReader("Sales", tight.Limits, tight.Pool);
        var seedRefused = !refused.Seed(small, listing, plan.Keeps);
        tight.Budget.Release(tight.Budget.Limit);
        check(seedRefused && tight.Budget.Used == used, "a seed past the budget answers false and gives back what it took");
        tight.Connection.Abandon(small);
        check(tight.Empty, "and the saved read given back leaves nothing held");
    }

    private static bool ReleaseRead(IndexFileChecks.World world, DatabaseIndex read)
    {
        world.Connection.Abandon(read);
        return true;
    }

    private static string Diff(string actual, string expected)
    {
        var a = actual.Split('\n');
        var e = expected.Split('\n');
        var text = new StringBuilder();
        foreach (var line in a.Except(e)) text.Append("+ ").Append(line).Append('\n');
        foreach (var line in e.Except(a)) text.Append("- ").Append(line).Append('\n');
        return text.ToString();
    }
}
