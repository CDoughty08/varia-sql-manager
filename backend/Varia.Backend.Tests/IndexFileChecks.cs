using System.Data;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Google.Apis.Bigquery.v2.Data;
using Varia.Backend.Search;

namespace Varia.Backend.Tests;

/// <summary>
/// Offline checks of the Search Objects index's on-disk format (<see cref="IndexFile"/>): a unit saved and loaded is the unit
/// it was for every reader (Search, the editor's lookups, the status counts, the Memory panel's report, what a BigQuery build
/// reuses); a load takes from the pool and the budget what the read took, and gives everything back when it is refused; a
/// hostile file is refused by a reason, never loaded into a table that breaks a rule its readers rely on; a write replaces
/// its target whole or not at all; and the committed files of each format version still load to what they held.
/// Units come from the real readers, fed the fakes the other suites feed them.
/// </summary>
internal static partial class IndexFileChecks
{
    /// <summary>The key the checks and the committed files are written under: fixed, and of no other use.</summary>
    internal static readonly byte[] TestKey = [.. Enumerable.Range(0, 32).Select(at => (byte)(at * 7 + 3))];
    private static readonly IndexFileProtection Sealed = IndexFileProtection.Encrypted(TestKey);
    private static readonly IndexFileProtection Clear = IndexFileProtection.ClearText;
    private static readonly (string Name, IndexFileProtection Protection)[] Modes = [("encrypted", Sealed), ("clear text", Clear)];
    private static readonly byte[] Identity = "checks/connection-1/unit"u8.ToArray();
    private static readonly byte[] Sync = "listing 2026-11-01"u8.ToArray();
    private static readonly ObjectIndexStatus Ready = new("ready", 1, 1, 0, 0, 0, [], true);
    private static readonly JsonSerializerOptions Json = new() { IncludeFields = true };
    private static readonly DateTime At = new(2026, 11, 1, 8, 30, 0, DateTimeKind.Unspecified);
    /// <summary>A date an entry's 32 bits cannot hold: kept in the table's side list.</summary>
    private static readonly DateTime Old = new(1899, 12, 31, 0, 0, 0, DateTimeKind.Unspecified);

    public static async Task RunAsync(Action<bool, string> check)
    {
        await RoundTrips(check);
        await Resources(check);
        await Accounting(check);
        await Fallbacks(check);
        await Refusals(check);
        await Chunks(check);
        await Fuzz(check);
        await Atomic(check);
        await Concurrent(check);
        await Golden(check);
    }

    // ---- The units, read by the real readers from fakes ----

    /// <summary>One budget, pool, resource catalog and connection: what a unit is read into, or loaded into.</summary>
    internal sealed class World
    {
        public World(ObjectIndexLimits? limits = null)
        {
            Limits = limits ?? new ObjectIndexLimits { DefinitionChars = 2000 };
            Budget = new IndexBudget(Limits.MemoryBytes);
            Pool = new StringPool(Budget);
            Catalog = new ResourceCatalog(Pool, () => Limits.NamesReserveBytes);
            Connection = new ConnectionIndex(Budget, Catalog, Pool);
        }

        public ObjectIndexLimits Limits { get; }
        public IndexBudget Budget { get; }
        public StringPool Pool { get; }
        public ResourceCatalog Catalog { get; }
        public ConnectionIndex Connection { get; }

        public void Hold(DatabaseIndex unit, IndexUnitKind kind)
        {
            if (kind == IndexUnitKind.Server) Connection.PutServer(unit);
            else if (kind == IndexUnitKind.Agent) Connection.PutAgent(unit);
            else Connection.Put(unit);
        }

        public IndexMemoryDetail Memory => IndexMemoryReport.Detail(Budget, Pool, [Connection], Catalog.Held);
        public bool Empty => Budget.Used == 0 && Pool.Count == 0;
    }

    private static DataTable Rows((string Name, Type Type)[] columns, params object?[][] rows)
    {
        var table = new DataTable();
        foreach (var (name, type) in columns) table.Columns.Add(name, type);
        foreach (var row in rows) table.Rows.Add([.. row.Select(value => value ?? DBNull.Value)]);
        return table;
    }

    /// <summary>A module's text, long enough to be packed and short enough to stay under the checks' definition limit.</summary>
    internal static string Module(string name, int lines = 12)
    {
        var text = new StringBuilder("CREATE PROCEDURE dbo." + name + " @from date, @to date\r\nAS\r\nBEGIN\r\n");
        for (var line = 0; line < lines; line++)
            text.Append("\tUPDATE dbo.Ledger SET Amount = Amount + ").Append(line * 7 + name.Length).Append(" WHERE PostedAt BETWEEN @from AND @to AND RuleId = ").Append(line).Append(";\r\n");
        return text.Append("END -- ").Append(name).Append("\r\n").ToString();
    }

    /// <summary>
    /// A database batch with everything a read keeps: tables with typed columns, keys, an index, a foreign key and one to a
    /// table the login cannot see, a temporal history table, a date before 1970, a child whose parent the login cannot see
    /// (removed), a column of a procedure (its name pooled, the row left out), a table type, a function with a return type,
    /// a database trigger, a plan guide, and definitions: short, shared by two constraints, long (packed), cut at the limit,
    /// long with an unpaired surrogate (kept as a string), a computed column's. The collation is Turkish, case ignored.
    /// </summary>
    internal static SearchCostChecks.Batch DatabaseBatch(bool children, bool definitions, int extraTables = 0)
    {
        object?[] Object(int id, string name, string type, int parent = 0, byte variant = 0, int? current = null, DateTime? modified = null) =>
            [id, "dbo", name, type, modified ?? At, parent, false, variant, current];
        var objects = new List<object?[]>
        {
            Object(5, "trg_orders", "TR", 10), Object(10, "Orders", "U"), Object(20, "Customers", "U", modified: Old), Object(11, "Prices_History", "U", variant: 6, current: 12),
            Object(12, "Prices", "U"), Object(13, "Gone_History", "U", variant: 8, current: 14), Object(14, "Gone", "U", variant: 5), Object(30, "pk_orders", "PK", 10),
            Object(31, "fk_orders_customers", "F", 10), Object(32, "uq_customers", "UQ", 20), Object(33, "pk_list", "PK", 900), Object(34, "fk_hidden", "F", 10),
            Object(35, "ck_orders_total", "C", 10), Object(36, "df_orders_note", "D", 10), Object(37, "df_customers_note", "D", 20), Object(38, "ck_orphan", "C", 999),
            Object(40, "usp_get", "P"), Object(41, "fn_total", "FN"), Object(42, "usp_long", "P"), Object(43, "usp_cut", "P"), Object(44, "usp_lone", "P"),
            Object(45, "vw_İstanbul", "V"), Object(46, "usp_short", "P")
        };
        for (var extra = 0; extra < extraTables; extra++) objects.Add(Object(1000 + extra, "Extra_" + extra, "U"));
        var sets = new List<DataTable>
        {
            Rows([("id", typeof(int)), ("schema", typeof(string)), ("name", typeof(string)), ("type", typeof(string)), ("modified", typeof(DateTime)), ("parent", typeof(int)),
                ("system", typeof(bool)), ("variant", typeof(byte)), ("current", typeof(int))], [.. objects]),
            Rows([("id", typeof(int)), ("schema", typeof(string)), ("name", typeof(string)), ("table", typeof(bool)), ("assembly", typeof(bool)), ("object", typeof(int))],
                [257, "dbo", "List", true, false, 900], [258, "dbo", "Phone", false, false, null]),
            Rows([("code", typeof(string)), ("schema", typeof(string)), ("name", typeof(string)), ("modified", typeof(DateTime)), ("system", typeof(bool))],
                ["SC", null, "sales", null, false], ["XS", "dbo", "Shapes", At, false], ["US", null, "dbo", At, true]),
            Rows([("id", typeof(int)), ("name", typeof(string)), ("modified", typeof(DateTime)), ("system", typeof(bool))], [50, "ddl_audit", At, false]),
            definitions
                ? Rows([("name", typeof(string)), ("modified", typeof(DateTime)), ("text", typeof(string))], ["pg_orders", At, "SELECT id FROM dbo.Orders OPTION (RECOMPILE)"])
                : Rows([("name", typeof(string)), ("modified", typeof(DateTime))], ["pg_orders", At])
        };
        if (children)
        {
            object?[] Column(int id, string name, int column, int type, short length, byte precision, byte scale, bool nullable, bool identity = false, bool computed = false,
                bool hasDefault = false, int? dimensions = null, string? expression = null) =>
                definitions ? [id, name, column, type, length, precision, scale, nullable, identity, computed, hasDefault, dimensions, expression]
                    : [id, name, column, type, length, precision, scale, nullable, identity, computed, hasDefault, dimensions];
            var columns = new List<object?[]>
            {
                Column(10, "id", 1, 56, 4, 10, 0, false, identity: true), Column(10, "customer_id", 2, 56, 4, 10, 0, false),
                Column(10, "total", 3, 106, 9, 18, 2, true, computed: true, expression: "([qty]*[price])"), Column(10, "name", 4, 231, 100, 0, 0, true, hasDefault: true),
                Column(10, "note", 5, 231, -1, 0, 0, true), Column(10, "phone", 6, 258, 50, 0, 0, true), Column(10, "embedding", 8, 255, 20, 0, 0, true, dimensions: 3),
                Column(11, "valid_from", 1, 56, 4, 10, 0, false), Column(20, "id", 1, 56, 4, 10, 0, false), Column(20, "İsim", 2, 231, 100, 0, 0, true),
                Column(40, "ghost", 1, 56, 4, 10, 0, false), Column(900, "value", 1, 56, 4, 10, 0, false), Column(998, "hidden_col", 1, 56, 4, 10, 0, false)
            };
            for (var extra = 0; extra < extraTables; extra++)
                for (var column = 1; column <= 4; column++) columns.Add(Column(1000 + extra, "extra_column_" + extra + "_" + column, column, 231, 100, 0, 0, true));
            var columnTypes = new List<(string, Type)>
            {
                ("id", typeof(int)), ("name", typeof(string)), ("column", typeof(int)), ("type", typeof(int)), ("length", typeof(short)), ("precision", typeof(byte)), ("scale", typeof(byte)),
                ("nullable", typeof(bool)), ("identity", typeof(bool)), ("computed", typeof(bool)), ("default", typeof(bool)), ("dimensions", typeof(int))
            };
            if (definitions) columnTypes.Add(("expression", typeof(string)));
            sets.Add(Rows([("id", typeof(int)), ("schema", typeof(string)), ("name", typeof(string)), ("system", typeof(byte)), ("user", typeof(bool)), ("table", typeof(bool))],
                [.. SearchChecks.SystemTypes, [257, "dbo", "List", (byte)243, true, true], [258, "dbo", "Phone", (byte)231, true, false], [255, "sys", "vector", (byte)165, false, false]]));
            sets.Add(Rows([.. columnTypes], [.. columns]));
            sets.Add(Rows([("id", typeof(int)), ("name", typeof(string)), ("type", typeof(byte)), ("index", typeof(int))],
                [10, "pk_orders", (byte)1, 1], [10, "ix_orders_customer", (byte)2, 2], [20, "uq_customers", (byte)2, 2], [900, "PK__List", (byte)1, 1], [998, "ix_hidden", (byte)2, 2]));
            sets.Add(Rows([("id", typeof(int)), ("name", typeof(string))], [10, "_WA_Sys_1"], [900, "st_list"]));
            sets.Add(Rows([("id", typeof(int)), ("name", typeof(string)), ("output", typeof(bool)), ("parameter", typeof(int)), ("type", typeof(int)), ("length", typeof(short)),
                ("precision", typeof(byte)), ("scale", typeof(byte)), ("readonly", typeof(bool)), ("dimensions", typeof(int))],
                [40, "@id", false, 1, 56, (short)4, (byte)10, (byte)0, false, null], [40, "@rows", true, 2, 56, (short)4, (byte)10, (byte)0, false, null],
                [40, "@list", false, 3, 257, (short)-1, (byte)0, (byte)0, true, null], [41, "", false, 0, 106, (short)9, (byte)18, (byte)2, false, null],
                [41, "@x", false, 1, 56, (short)4, (byte)10, (byte)0, false, null]));
            sets.Add(Rows([("id", typeof(int)), ("index", typeof(int)), ("column", typeof(int)), ("descending", typeof(bool)), ("included", typeof(bool))],
                [10, 1, 1, false, false], [10, 2, 2, true, false], [10, 2, 4, false, true], [20, 2, 1, false, false], [900, 1, 1, false, false], [998, 2, 1, false, false]));
            sets.Add(Rows([("id", typeof(int)), ("parent", typeof(int)), ("index", typeof(int))], [30, 10, 1], [32, 20, 2], [33, 900, 1], [999, 10, 1]));
            sets.Add(Rows([("id", typeof(int)), ("column", typeof(int)), ("referenced", typeof(int)), ("other", typeof(int))], [31, 2, 20, 1], [34, 1, 997, 1], [998, 1, 20, 1]));
        }
        if (definitions)
            sets.Add(Rows([("id", typeof(int)), ("text", typeof(string))],
                [5, "CREATE TRIGGER dbo.trg_orders ON dbo.Orders AFTER INSERT AS SELECT 1"], [35, "([total]>(0))"], [36, "((0))"], [37, "((0))"], [38, "([lost]>(0))"],
                [40, "CREATE PROCEDURE dbo.usp_get @id int AS SELECT @id"], [42, Module("usp_long")], [43, Module("usp_cut", 40)], [44, Module("usp_lone") + "\uD83D"],
                [45, "CREATE VIEW dbo.vw_İstanbul AS SELECT id FROM dbo.Orders"], [46, "SELECT 1"], [50, "CREATE TRIGGER ddl_audit ON DATABASE FOR DDL_DATABASE_LEVEL_EVENTS AS RETURN"]));
        sets.Add(Rows([("cased", typeof(bool)), ("dotted", typeof(bool))], [false, true]));
        return new SearchCostChecks.Batch([.. sets]);
    }

    private static async Task<DatabaseIndex> Database(World world, bool children = true, bool definitions = true, DatabaseIndex? credit = null, int extraTables = 0, string name = "Sales")
    {
        var read = await new DatabaseReader(name, world.Limits, world.Pool, credit).ReadAsync(DatabaseBatch(children, definitions, extraTables), definitions, CancellationToken.None, children)
            ?? throw new InvalidOperationException("The checks' database did not fit.");
        read.ChildrenLeftOut = !children;
        return read;
    }

    /// <summary>The server's own objects: databases (one from before 1970), logins, roles, a linked server, a server trigger with its text.</summary>
    private static async Task<DatabaseIndex> Server(World world)
    {
        var reader = new SearchCostChecks.Batch([
            Rows([("name", typeof(string)), ("created", typeof(DateTime)), ("system", typeof(bool)), ("snapshot", typeof(bool))],
                ["master", Old, true, false], ["Sales", At, false, false], ["Sales_snapshot", At, false, true]),
            Rows([("principal", typeof(int)), ("name", typeof(string)), ("type", typeof(string)), ("modified", typeof(DateTime)), ("fixed", typeof(bool))],
                [1, "sa", "S", At, false], [2, "public", "R", At, false], [3, "sysadmin", "R", At, true], [260, "app_login", "S", At, false]),
            Rows([("code", typeof(string)), ("name", typeof(string)), ("modified", typeof(DateTime))], ["LS", "LINKED1", At], ["CR", "backup_credential", null]),
            Rows([("id", typeof(int)), ("name", typeof(string)), ("modified", typeof(DateTime)), ("system", typeof(bool))], [70, "trg_logon", At, false]),
            Rows([("id", typeof(int)), ("text", typeof(string))], [70, Module("trg_logon")])
        ]);
        return await new DatabaseReader(ObjectSearchService.ServerScope, world.Limits, world.Pool).ReadServerAsync(reader, true, true, Actions.ActionsCatalog.Current.Logins, CancellationToken.None)
            ?? throw new InvalidOperationException("The checks' server objects did not fit.");
    }

    private static async Task<DatabaseIndex> Agent(World world)
    {
        var reader = new DataTableReader([
            Rows([("code", typeof(string)), ("name", typeof(string)), ("modified", typeof(DateTime))], ["AJ", "Nightly", At], ["AJ", "Undated", null]),
            Rows([("code", typeof(string)), ("name", typeof(string))], ["AA", "Severity 17"], ["AO", "DBA team"])
        ]);
        return await new DatabaseReader("msdb", world.Limits, world.Pool).ReadAgentAsync(reader, true, CancellationToken.None) ?? throw new InvalidOperationException("The checks' Agent objects did not fit.");
    }

    /// <summary>The resource database's objects as its reader leaves them: views, a function and a procedure with typed columns
    /// and parameters, and their definitions (one long).</summary>
    private static Task<ObjectTable> ResourceObjects(World world, bool definitions = true)
    {
        var sets = new List<DataTable>
        {
            Rows([("id", typeof(int)), ("schema", typeof(string)), ("name", typeof(string)), ("type", typeof(string)), ("modified", typeof(DateTime))],
                [-100, "sys", "objects", "V", At], [-200, "sys", "fn_hash", "FN", Old], [-300, "sys", "sp_who", "P", At], [-400, "INFORMATION_SCHEMA", "TABLES", "V", At]),
            Rows([("id", typeof(int)), ("schema", typeof(string)), ("name", typeof(string)), ("system", typeof(byte)), ("user", typeof(bool)), ("table", typeof(bool))], SearchChecks.SystemTypes),
            Rows([("id", typeof(int)), ("name", typeof(string)), ("column", typeof(int)), ("type", typeof(int)), ("length", typeof(short)), ("precision", typeof(byte)), ("scale", typeof(byte)),
                ("nullable", typeof(bool)), ("identity", typeof(bool)), ("computed", typeof(bool)), ("default", typeof(bool)), ("dimensions", typeof(int))],
                [-100, "name", 1, 256, (short)256, (byte)0, (byte)0, false, false, false, false, null], [-100, "object_id", 2, 56, (short)4, (byte)10, (byte)0, false, false, false, false, null],
                [-400, "TABLE_NAME", 1, 256, (short)256, (byte)0, (byte)0, false, false, false, false, null]),
            Rows([("id", typeof(int)), ("name", typeof(string)), ("output", typeof(bool)), ("parameter", typeof(int)), ("type", typeof(int)), ("length", typeof(short)), ("precision", typeof(byte)),
                ("scale", typeof(byte)), ("readonly", typeof(bool)), ("dimensions", typeof(int))],
                [-200, "", false, 0, 56, (short)4, (byte)10, (byte)0, false, null], [-300, "@loginame", false, 1, 256, (short)256, (byte)0, (byte)0, false, null])
        };
        if (definitions)
            sets.Add(Rows([("id", typeof(int)), ("text", typeof(string))], [-100, Module("sys_objects")], [-300, "CREATE PROCEDURE sys.sp_who @loginame sysname = NULL AS SELECT 1"],
                [-400, Module("information_schema_tables", 40)]));
        return DatabaseReader.ReadResourceAsync(new SearchCostChecks.Batch([.. sets]), definitions, world.Limits, CancellationToken.None);
    }

    internal static readonly ResourceKey ResourceKey = new("17.0.1000.7", 3, 4, At, 42, true);

    private static T Fixture<T>(string name) => Google.Apis.Json.NewtonsoftJsonSerializer.Instance.Deserialize<T>(BigQueryFake.FixtureText(name));

    /// <summary>
    /// A BigQuery dataset's entries from the listings and the tables.get and routines.get answers the index suite's fake
    /// serves: a date-sharded group, a snapshot, a clone, a view with its text, a materialized view, a table with nested
    /// and repeated fields, routines with signatures, a model, a table with described columns, and one object pass 2 never read.
    /// </summary>
    internal static List<BigQueryEntry> DatasetEntries()
    {
        var listing = new BigQueryListing([.. Fixture<TableList>("index-tables").Tables], [.. Fixture<ListRoutinesResponse>("index-routines").Routines],
            [.. Fixture<ListModelsResponse>("index-models").Models], false);
        var described = new Table
        {
            Type = "TABLE", NumRows = 12, NumBytes = 4096, LastModifiedTime = 1700086400000, RangePartitioning = new RangePartitioning { Field = "bucket" },
            Schema = new TableSchema
            {
                Fields =
                [
                    new TableFieldSchema { Name = "bucket", Type = "INTEGER", Mode = "REQUIRED", Description = "The range partition." },
                    // Named as a routine listed after the tables: the read charges the text once, as this column's.
                    new TableFieldSchema { Name = "to_cents", Type = "INTEGER" },
                    new TableFieldSchema
                    {
                        Name = "customer", Type = "RECORD", Description = new string('d', 2000),
                        Fields = [new TableFieldSchema { Name = "name", Type = "STRING", MaxLength = 80 }, new TableFieldSchema { Name = "spend", Type = "NUMERIC", Precision = 10, Scale = 2, Mode = "REPEATED" }]
                    }
                ]
            }
        };
        var entries = new List<BigQueryEntry>();
        var skipped = false;
        foreach (var entry in BigQueryEntries.FromListing(listing))
        {
            BigQueryDetail? detail = entry.Kind switch
            {
                "bqModel" => null,
                "bqRoutine" => BigQueryEntries.FromRoutine(Fixture<Routine>(entry.Name == "to_cents" ? "index-routine-to-cents" : "routine-procedure")),
                _ => BigQueryEntries.FromTable(entry.Name switch
                {
                    "daily" => Fixture<Table>("index-view-daily"),
                    "orders_copy" => Fixture<Table>("index-table-copy"),
                    "events_20260103" => Fixture<Table>("index-table-events"),
                    "orders" => Fixture<Table>("table-orders"),
                    _ => described
                })
            };
            // One table pass 2 never reached: listed, without details.
            if (detail is not null && !skipped && entry.Kind == "bqTable" && entry.Name.StartsWith("audit_", StringComparison.Ordinal)) (detail, skipped) = (null, true);
            // One whose details are carried from an earlier generation of it, until pass 2 reads it again.
            if (entry.Name == "orders_copy") detail = detail! with { Carried = true, Stale = true };
            entries.Add(entry with { Detail = detail });
        }
        return entries;
    }

    /// <summary>The same dataset as the billed bulk path reads it: columns and text from INFORMATION_SCHEMA rows, no facts.</summary>
    internal static List<BigQueryEntry> BulkEntries()
    {
        var rows = new BigQueryBulkDataset("sales");
        rows.Add("orders", "BASE TABLE", new("id", "INT64", "The order.", 1, false));
        rows.Add("orders", "BASE TABLE", new("address", "STRUCT<city STRING, geo STRUCT<lat FLOAT64 NOT NULL>>", null, 2, true));
        rows.Add("daily", "VIEW", new("day", "DATE", null, 1, true));
        rows.AddText(rows.Views, "daily", "SELECT DATE(placed) AS day FROM `varia-alpha.sales.orders`");
        rows.AddText(rows.Routines, "to_cents", "CAST(ROUND(dollars * 100) AS INT64)");
        List<BigQueryEntry> listed =
        [
            new("bqTable", "bqTables", null, "orders", 1700000000000, null), new("bqView", "bqViews", null, "daily", 1700000000000, null),
            new("bqRoutine", "bqRoutines", "scalar", "to_cents", 1700000000000, 1700000600000), new("bqTable", "bqTables", null, "not_in_rows", 1700000000000, null)
        ];
        return [.. listed.Select(entry => entry with { Detail = BigQueryBulk.Detail(rows, entry, true) })];
    }

    private static DatabaseIndex Dataset(World world, List<BigQueryEntry> entries, bool children = true, bool definitions = true, DatabaseIndex? credit = null, bool discovered = false) =>
        new BigQueryReader(world.Limits, world.Pool, credit, world.Limits.BigQueryNamesFloorBytes, world.Limits.BigQueryDetailsFloor(discovered, credit is { Detailed: true }))
            .Read("varia-alpha", "sales", entries, children, definitions) ?? throw new InvalidOperationException("The checks' dataset did not fit.");

    /// <summary>Every kind of unit a round trip is checked for, each read into the world it is given.</summary>
    private static readonly (string Name, IndexUnitKind Kind, Func<World, Task<DatabaseIndex>> Read)[] Units =
    [
        ("a database", IndexUnitKind.Database, world => Database(world)),
        ("a database read without definitions", IndexUnitKind.Database, world => Database(world, definitions: false)),
        ("a database read without children", IndexUnitKind.Database, world => Database(world, children: false)),
        ("a server's objects", IndexUnitKind.Server, Server),
        ("SQL Server Agent's objects", IndexUnitKind.Agent, Agent),
        ("a BigQuery dataset", IndexUnitKind.Dataset, world => Task.FromResult(Dataset(world, DatasetEntries()))),
        ("a BigQuery dataset read without columns", IndexUnitKind.Dataset, world => Task.FromResult(Dataset(world, DatasetEntries(), children: false))),
        ("a BigQuery dataset read without definitions", IndexUnitKind.Dataset, world => Task.FromResult(Dataset(world, DatasetEntries(), definitions: false))),
        ("a BigQuery dataset read by the bulk path", IndexUnitKind.Dataset, world => Task.FromResult(Dataset(world, BulkEntries())))
    ];

    // ---- What a unit is, to each of its readers, as text two units are compared by ----

    private static string Hash(ReadOnlySpan<char> text) => Convert.ToHexString(SHA256.HashData(System.Runtime.InteropServices.MemoryMarshal.AsBytes(text)))[..16];

    /// <summary>A table as it is held: every entry through every accessor, its texts in id order (their form and content), which
    /// of them are names and definitions, and its details. Two tables with the same text are the same table to any reader.</summary>
    internal static string Dump(ObjectTable table, BigQueryFacts? facts = null, bool texts = true)
    {
        var text = new StringBuilder();
        for (var at = 0; at < table.Count; at++)
        {
            var row = table.Row(at);
            var stored = table.StoredDefinition(at);
            text.Append(at).Append('|').Append(row.Kind).Append('|').Append(row.Folder).Append('|').Append(row.Subtype).Append('|').Append(row.Schema).Append('|').Append(row.Name)
                .Append('|').Append(row.ParentKind).Append('.').Append(row.ParentSchema).Append('.').Append(row.ParentName).Append('.').Append(row.ParentFolder)
                .Append('|').Append(table.Parent(at)).Append('|').Append(table.Via(at)).Append('|').Append(row.Via?.Label)
                .Append('|').Append(row.Modified is { } modified ? modified.Ticks + ":" + modified.Kind : "-")
                .Append('|').Append(stored is null ? "-" : (stored is PackedText ? "P" : "S") + DefinitionText.Length(stored) + ":" + Hash(row.Definition)).Append(row.DefinitionCut ? "!" : "")
                .Append('|').Append(row.System ? "sys" : "").Append('|').Append(table.Label(at)).Append('|').Append(table.LabelLength(at))
                .Append('|').Append(table.Typed(at) is { } typed ? JsonSerializer.Serialize(typed, Json) : "-")
                .Append('|').Append(string.Join(",", table.KeyColumns(at).Select(column => column.Column + ":" + column.Referenced + ":" + column.Flags))).Append('|').Append(table.Referenced(at));
            if (facts is not null)
                text.Append('|').Append(facts.Of(at) is { } fact ? JsonSerializer.Serialize(fact, Json) : "-").Append('|').Append(facts.Description(at) is { } description ? Hash(description) + description.Length : "-")
                    .Append('|').Append(facts.Shards(at) is { } shards ? JsonSerializer.Serialize(shards, Json) : "-");
            text.Append('\n');
        }
        // The texts held, in order: a text the table gave back (a definition left out for memory) is no reader's.
        var (names, definitions) = (table.NameTexts(), table.DefinitionTexts());
        for (int id = 0, held = 0; texts && id < table.Texts.Count; id++)
            if (table.Texts[id] is { } stored)
                text.Append('t').Append(held++).Append('|').Append(stored is string value ? "S" + value.Length + ":" + Hash(value) : "P" + DefinitionText.Length(stored) + ":" + Hash(DefinitionText.ToText(stored)))
                    .Append(names[id] ? "|name" : "").Append(definitions[id] ? "|definition" : "").Append('\n');
        if (table.Details is { } details)
            text.Append("details|").Append(details.Types).Append('|').Append(details.TypedCount).Append('|').Append(details.KeyCount).Append('|').Append(details.KeyColumns).Append('|').Append(details.Bytes)
                .Append('|').Append(string.Join(",", details.ForeignKeys().Select(key => key.At + ">" + key.Referenced))).Append('\n');
        if (facts is not null) text.Append("facts|").Append(facts.Count).Append('\n');
        return text.ToString();
    }

    /// <summary>A read: what the status and the Memory panel count of it, and its table.</summary>
    /// <param name="texts">Without: not the order its texts are held in, which is the order a read first named them (a load
    /// without children holds them in the order the whole read did).</param>
    internal static string Dump(DatabaseIndex unit, bool readAt = true, bool texts = true) =>
        $"{unit.Database}|{unit.Dataset}|{unit.Key.Replace('\u0001', '/')}|{unit.Bytes}|{unit.Modules}|{unit.Cut}|{unit.LeftOut}|{unit.ChildrenLeftOut}|{unit.DefinitionsLeftOut}|{unit.Detailed}"
        + $"|{unit.CaseSensitive}|{unit.DottedI}|{unit.FailedPart}|{(readAt ? unit.ReadAt.Ticks : 0)}:{unit.ReadAt.Kind}|{unit.Table.Count}|{unit.Pooled.Length}|{unit.Facts is not null}|{unit.NameBytes}\n" + Dump(unit.Table, unit.Facts, texts);

    private static readonly (string Text, bool Case, bool Word, bool Regex, bool Names, bool Definitions, string[]? Kinds, int Limit, bool Fuzzy)[] Queries =
    [
        ("o", false, false, false, true, false, null, 500, false), ("orders", false, false, false, true, true, null, 500, false), ("Orders", true, true, false, true, false, null, 500, false),
        ("dbo.Ord", false, false, false, true, false, null, 500, false), ("Ord*s", false, false, false, true, false, null, 500, false), ("^usp_\\w+$", false, false, true, true, false, null, 500, false),
        ("ordres", false, false, false, true, false, null, 500, true), ("istanbul", false, false, false, true, true, null, 500, false), ("SELECT", false, false, false, false, true, null, 500, false),
        ("RuleId = 7", true, false, false, false, true, null, 500, false), ("Ledger", false, true, false, true, true, null, 3, false), ("id", false, false, false, true, false, ["column", "bqColumn"], 500, false),
        ("e", false, false, false, true, false, ["table", "bqTable", "bqTable:snapshot"], 500, false), ("e", false, false, false, true, true, ["bqRoutine", "bqRoutine:procedure", "procedure"], 500, false),
        ("events_", false, false, false, true, false, null, 500, false), ("address.city", false, false, false, true, false, null, 500, false), ("sales", false, false, false, true, false, null, 500, false),
        ("s", false, false, false, true, true, null, 2, false), ("sys", false, false, false, true, true, null, 500, false), ("logon", false, false, false, true, true, null, 500, false)
    ];

    /// <summary>What every search of the checks answers over a connection: hits, their order, ranges, previews, counts and cut marks.</summary>
    internal static string Searches(World world, string? database = null)
    {
        var text = new StringBuilder();
        foreach (var item in Queries)
        {
            var query = new SearchQuery(item.Text, item.Case, item.Word, item.Regex, item.Names, item.Definitions, item.Kinds?.ToHashSet(), database, item.Limit, item.Fuzzy);
            var matcher = SearchMatcher.Create(query.Text, query.CaseSensitive, query.WholeWord, query.Regex, world.Limits.MatchTimeout).Matcher!;
            var result = IndexSearch.Run(world.Connection, query, matcher, new ObjectIndexLimits { SearchBudget = TimeSpan.FromMinutes(5) }, Ready, CancellationToken.None);
            text.Append(item.Text).Append(" => ").Append(result.Total).Append(result.Partial ? " partial " : " ").Append(JsonSerializer.Serialize(result.Hits, Json)).Append('\n');
        }
        return text.ToString();
    }

    /// <summary>What the editor's lookup answers for every object of a SQL Server connection: its state and case rule, each
    /// object by name (the Turkish i too), columns, parameters, indexes and keys, and foreign keys both ways.</summary>
    internal static string Lookups(World world, bool readAt = true)
    {
        var text = new StringBuilder();
        var lookup = new IndexLookup(world.Connection, world.Budget, false, new LookupLedger().Snapshot());
        static string Column(LookupColumn column) => column.Name + "#" + column.Ordinal + ":" + column.Type?.TypeText + ":" + column.Type?.Flags;
        static string Named(LookupObject value) => value.Kind + ":" + value.Schema + "." + value.Name + ":" + value.Type?.TypeText;
        foreach (var held in world.Connection.Databases.OrderBy(value => value.Key, StringComparer.Ordinal))
        {
            var database = lookup.Database(held.Database);
            text.Append(database.Database).Append('|').Append(database.State).Append('|').Append(database.Gaps).Append('|').Append(readAt ? database.ReadAt?.Ticks : 0).Append('|').Append(database.CaseSensitive).Append('\n');
            var names = Enumerable.Range(0, held.Table.Count).Where(at => held.Table.Parent(at) < 0).Select(held.Table.Name).Concat(["ORDERS", "VW_ISTANBUL", "vw_istanbul", "objects", "sp_who", "missing"]).Distinct(StringComparer.Ordinal);
            foreach (var name in names)
                foreach (var found in lookup.Objects(held.Database, null, name).Value)
                {
                    text.Append(name).Append(" -> ").Append(Named(found)).Append(" columns[").AppendJoin(',', lookup.Columns(found).Select(Column)).Append("] parameters[")
                        .AppendJoin(',', lookup.Parameters(found).Select(Column)).Append("] indexes[")
                        .AppendJoin(',', lookup.Indexes(found).Select(index => index.Entry.Name + ":" + index.Kind + ":" + index.Subtype + "(" + string.Join(" ", index.Columns.Select(column => column.Name + (column.Descending ? "-" : "") + (column.Included ? "+" : ""))) + ")"))
                        .Append("] keys[").AppendJoin(',', lookup.ForeignKeys(found).Select(key => key.Entry.Name + ">" + key.Referenced?.Name + "(" + string.Join(" ", key.Pairs.Select(pair => pair.Column + "=" + pair.ReferencedColumn)) + ")"))
                        .Append("] referenced[").AppendJoin(',', lookup.ReferencedBy(found).Select(key => key.Entry.Name + "<" + key.Table.Name)).Append("]\n");
                }
        }
        return text.ToString();
    }

    /// <summary>What the BigQuery lookup answers for a connection's datasets: states, objects, facts, sharded groups by wildcard
    /// and by shard, columns by path with types and descriptions, and what a later build would reuse of each read.</summary>
    internal static string BigQueryLookups(World world)
    {
        var text = new StringBuilder();
        var lookup = new BigQueryLookup("varia-alpha", [], world.Connection.Databases, null, [], false, true, world.Budget, keepFree: world.Limits.BigQueryNamesFloorBytes);
        foreach (var project in lookup.Projects)
            foreach (var name in lookup.Datasets(project))
            {
                var dataset = lookup.Dataset(project, name);
                text.Append(dataset.Project).Append('.').Append(dataset.Dataset).Append('|').Append(dataset.State).Append('\n');
                foreach (var entry in lookup.Objects(dataset))
                    text.Append(entry.Kind).Append(':').Append(entry.Name).Append('|').Append(JsonSerializer.Serialize(BigQueryLookup.Facts(entry), Json)).Append('|')
                        .Append(JsonSerializer.Serialize(BigQueryLookup.Shards(entry), Json)).Append("|[")
                        .AppendJoin(',', lookup.Columns(entry).Select(column => column.Name + "#" + column.Ordinal + ":" + column.Type?.TypeName + ":" + column.Type?.Flags + ":" + BigQueryLookup.Description(column)?.Length)).Append("]\n");
                foreach (var written in new[] { "events_*", "events_2026*", "events_20260102", "ORDERS", "orders", "daily", "to_cents", "missing", "events_summary" })
                    text.Append(written).Append(" -> ").Append(lookup.Object(dataset, written) is { } found ? found.Kind + ":" + found.Name : "-").Append('\n');
                if (dataset.Held is not { } read) continue;
                foreach (var (definitions, carry) in new[] { (true, false), (false, false), (true, true) })
                    text.Append("known ").Append(definitions).Append(carry).Append(' ').AppendJoin(';', BigQueryEntries.Known(read, definitions, carry).OrderBy(pair => pair.Key.Kind + "/" + pair.Key.Name, StringComparer.Ordinal)
                        .Select(pair => pair.Key + "=" + pair.Value.Created + "," + pair.Value.Modified + "," + JsonSerializer.Serialize(pair.Value.Detail, Json))).Append('\n');
                text.Append("detailed ").AppendJoin(',', BigQueryEntries.Detailed(read).Order()).Append('\n');
            }
        return text.ToString();
    }

    /// <summary>Everything a world's readers see of what it holds.</summary>
    internal static string Everything(World world) =>
        string.Join("\n", world.Connection.Held.OrderBy(unit => unit.Key, StringComparer.Ordinal).Select(unit => Dump(unit))) + Searches(world) + Searches(world, "Sales") + Lookups(world) + BigQueryLookups(world)
        + world.Connection.Objects + "|" + world.Memory;

    // ---- Saving and loading in memory ----

    internal static byte[] Save(DatabaseIndex unit, IndexUnitKind kind, IndexFileProtection protection, byte[]? extra = null, byte[]? sync = null)
    {
        using var stream = new MemoryStream();
        var problem = IndexFile.Save(stream, unit, kind, new IndexSaveOptions(protection, Identity, sync ?? Sync, extra ?? default(ReadOnlyMemory<byte>)));
        if (problem != IndexFileProblem.None) throw new InvalidOperationException("The checks' unit was not saved: " + problem);
        return stream.ToArray();
    }

    internal static IndexLoad<DatabaseIndex> Load(World world, byte[] file, IndexUnitKind kind, IndexFileProtection protection, DatabaseIndex? credit = null, bool children = true, bool discovered = false,
        byte[]? identity = null, CancellationToken token = default)
    {
        using var stream = new MemoryStream(file, writable: false);
        return IndexFile.Load(stream, new IndexLoadOptions(protection, kind, identity ?? Identity, credit, children, discovered), world.Limits, world.Pool, token);
    }

    // ---- Round trips ----

    private static async Task RoundTrips(Action<bool, string> check)
    {
        foreach (var (name, kind, read) in Units)
            foreach (var (mode, protection) in Modes)
            {
                var original = new World();
                var unit = await read(original);
                original.Hold(unit, kind);
                var (usedBefore, poolBefore) = (original.Budget.Used, original.Pool.Stats);
                byte[] extra = [9, 8, 7, 6, 5];
                var file = Save(unit, kind, protection, extra);
                check(original.Budget.Used == usedBefore && original.Pool.Stats == poolBefore, $"saving {name} ({mode}) takes nothing from the budget or the pool");

                using (var counted = new MemoryStream(file, writable: false))
                {
                    var header = IndexFile.ReadHeader(counted, protection);
                    check(header is { Problem: IndexFileProblem.None, Value: { } read1 } && read1.Version == IndexFileContainer.Version && read1.Encrypted == protection.IsEncrypted && read1.Kind == kind
                        && read1.Provider == (kind == IndexUnitKind.Dataset ? IndexProvider.BigQuery : IndexProvider.SqlServer) && read1.ReadAt == unit.ReadAt && read1.ReadAt.Kind == DateTimeKind.Utc
                        && read1.Definitions == !unit.DefinitionsLeftOut && read1.Children == !unit.ChildrenLeftOut && read1.Objects == unit.Table.Count && read1.MemoryBytes == unit.Bytes
                        && read1.Identity.AsSpan().SequenceEqual(Identity) && read1.Sync.AsSpan().SequenceEqual(Sync),
                        $"the header of {name} ({mode}) says what it holds: its version, kind, provider, when it was read, whether definitions and children are in it, and the caller's identity and sync state");
                    check(counted.Position == IndexFileContainer.PrefixBytes + IndexFileContainer.FixedHeaderBytes + Identity.Length + Sync.Length + (protection.IsEncrypted ? 16 : 32) && counted.Position < file.Length,
                        $"reading the header of {name} ({mode}) reads the header and not a byte of the body ({counted.Position} of {file.Length})");
                }

                var loadedInto = new World();
                var loaded = Load(loadedInto, file, kind, protection);
                check(loaded is { Problem: IndexFileProblem.None, Value: not null } && loaded.Extra!.AsSpan().SequenceEqual(extra) && loaded.Header!.Sync.AsSpan().SequenceEqual(Sync),
                    $"{name} ({mode}) loads, with the caller's sync state and extra bytes: {loaded.Problem}");
                if (loaded.Value is null) continue;
                check(loaded.Value.Credited == 0 && loaded.Value.CreditFrom is null && loaded.Value.Stamp > unit.Stamp && loaded.Value.LookupBytes == 0,
                    $"{name} ({mode}) loads as a read of its own: charged to the budget, stamped as read now, with no lookup arrays");
                check(loadedInto.Budget.Used == usedBefore && loadedInto.Pool.Stats == poolBefore,
                    $"loading {name} ({mode}) charges the budget and the pool exactly what its read did: {loadedInto.Budget.Used} of {usedBefore}, {loadedInto.Pool.Stats} of {poolBefore}");
                loadedInto.Hold(loaded.Value, kind);
                var (before, after) = (Everything(original), Everything(loadedInto));
                check(before == after, $"{name} ({mode}) is the same to every reader once loaded: its entries, texts and details, every search, every lookup, the status counts and the memory report"
                    + Difference(before, after));
                // The lookups above built each world's lookup arrays, which are part of neither file.
                check(loadedInto.Budget.Used == original.Budget.Used && loadedInto.Memory == original.Memory, $"the lookup arrays {name} ({mode}) builds once loaded cost what the read's cost");

                // Saved again from the loaded unit, the file holds the same content (the salt, and so the bytes, differ).
                var again = new World();
                var second = Load(again, Save(loaded.Value, kind, protection, extra), kind, protection);
                check(second.Value is not null && Dump(second.Value) == Dump(unit), $"{name} ({mode}) saved again from the loaded unit loads to the same unit");
                if (second.Value is not null) again.Connection.Abandon(second.Value);
                original.Connection.Dispose();
                loadedInto.Connection.Dispose();
                check(original.Empty && loadedInto.Empty && again.Empty, $"dropping {name} ({mode}), read or loaded, leaves the budget and the pool empty");
            }

        // The files of one unit differ wherever they can: a salt of their own, so keys of their own, so no byte of the body repeats.
        {
            var world = new World();
            var unit = await Database(world);
            var (one, two) = (Save(unit, IndexUnitKind.Database, Sealed), Save(unit, IndexUnitKind.Database, Sealed));
            var same = 0;
            for (var at = IndexFileContainer.PrefixBytes; at < one.Length; at++) if (one[at] == two[at]) same++;
            check(one.Length == two.Length && !one.AsSpan(20, 32).SequenceEqual(two.AsSpan(20, 32)) && same < one.Length / 16,
                $"two files of one unit under one key share no salt and nothing of their sealed bytes beyond chance ({same} of {one.Length})");
            var clear = Save(unit, IndexUnitKind.Database, Clear);
            check(Encoding.Unicode.GetString(clear).Contains("Orders", StringComparison.Ordinal) || IndexOf(Payload(clear, Clear), Encoding.Unicode.GetBytes("Customers")) >= 0,
                "a clear text file's content is readable once its blocks are unpacked");
            check(IndexOf(one, Encoding.Unicode.GetBytes("Orders")) < 0 && IndexOf(one, Identity) < 0 && IndexOf(one, Sync) < 0 && IndexOf(one, "Sales"u8) < 0,
                "an encrypted file shows no name, nor the caller's identity or sync state");
            world.Connection.Abandon(unit);
        }
    }

    private static int IndexOf(ReadOnlySpan<byte> bytes, ReadOnlySpan<byte> value) => bytes.IndexOf(value);

    /// <summary>Where two texts first differ, for a failed comparison's message.</summary>
    internal static string Difference(string expected, string actual)
    {
        if (expected == actual) return "";
        var at = 0;
        while (at < expected.Length && at < actual.Length && expected[at] == actual[at]) at++;
        var from = Math.Max(0, at - 120);
        return $": first differs at {at}: «{expected[from..Math.Min(expected.Length, at + 160)]}» against «{actual[from..Math.Min(actual.Length, at + 160)]}»";
    }

    /// <summary>The shared resource set: saved from the set a connection holds, loaded as a read answers it, and shared by the
    /// catalog exactly as a read's is, definitions left out for memory before the save still counted.</summary>
    private static async Task Resources(Action<bool, string> check)
    {
        foreach (var (mode, protection) in Modes)
            foreach (var starved in new[] { false, true })
            {
                var original = new World();
                // Starved: shared while less than the names' reserve was free, so every definition is left out and counted.
                if (starved) original.Limits.NamesReserveBytes = long.MaxValue / 4;
                var set = await original.Catalog.AcquireAsync(ResourceKey, _ => ResourceObjects(original));
                original.Connection.PutResource(set);
                var beside = await Database(original);
                original.Connection.Put(beside);
                var readAt = new DateTime(2026, 11, 2, 3, 4, 5, DateTimeKind.Utc);
                using var stream = new MemoryStream();
                var saved = IndexFile.SaveResource(stream, set, readAt, new IndexSaveOptions(protection, Identity, Sync));
                var file = stream.ToArray();
                IndexLoad<SavedResourceSet> LoadSet(long most = long.MaxValue)
                {
                    using var source = new MemoryStream(file, writable: false);
                    return IndexFile.LoadResource(source, protection, Identity, most);
                }
                var loaded = LoadSet();
                check(saved == IndexFileProblem.None && loaded is { Problem: IndexFileProblem.None, Value: { } value, Header: { Kind: IndexUnitKind.Resource, Provider: IndexProvider.SqlServer } header }
                    && value.Key == ResourceKey && header.ReadAt == readAt && header.Objects == set.Table.Count && header.MemoryBytes == set.Bytes && header.Definitions && header.Children,
                    $"the shared resource set ({mode}{(starved ? ", definitions left out" : "")}) saves and loads under its key: {saved} {loaded.Problem}");
                if (loaded.Value is null) continue;
                var loadedInto = new World();
                if (starved) loadedInto.Limits.NamesReserveBytes = long.MaxValue / 4;
                var shared = await loadedInto.Catalog.AcquireSavedAsync(loaded.Value.Key, _ => Task.FromResult(loaded.Value.Read));
                loadedInto.Connection.PutResource(shared);
                loadedInto.Connection.Put(Load(loadedInto, Save(beside, IndexUnitKind.Database, protection), IndexUnitKind.Database, protection).Value!);
                check((shared.Modules, shared.Cut, shared.LeftOut, shared.Bytes) == (set.Modules, set.Cut, set.LeftOut, set.Bytes) && Dump(shared.Table) == Dump(set.Table)
                    && (starved ? set is { Modules: 0, LeftOut: 3, Cut: 3 } : set is { Modules: 3, LeftOut: 0, Cut: 1 }),
                    $"the loaded set ({mode}) is shared as the read's was: {shared.Modules} modules, {shared.Cut} cut, {shared.LeftOut} left out, {shared.Bytes} bytes" + Difference(Dump(set.Table), Dump(shared.Table)));
                var (before, after) = (Everything(original), Everything(loadedInto));
                check(before == after && loadedInto.Budget.Used == original.Budget.Used && loadedInto.Pool.Stats == original.Pool.Stats,
                    $"a connection holding the loaded set ({mode}) searches and looks up the system objects as one holding the read's" + Difference(before, after));

                // A second connection takes the loaded set from the catalog: one copy, one more reference.
                var other = new ConnectionIndex(loadedInto.Budget, loadedInto.Catalog, loadedInto.Pool);
                var used = loadedInto.Budget.Used;
                var reads = 0;
                other.PutResource(await loadedInto.Catalog.AcquireSavedAsync(ResourceKey, _ => { reads++; return Task.FromResult(loaded.Value.Read); }));
                check(reads == 0 && ReferenceEquals(other.Resource, shared) && loadedInto.Budget.Used == used, $"a second connection shares the loaded set ({mode}) without loading it again");
                other.Dispose();
                // The loader bounds what the catalog will be made to hold whatever the budget: a set past the caller's bound is refused.
                var cost = set.Bytes + set.Table.Texts.OfType<object>().Sum(StringPool.Cost);
                check(LoadSet(cost).Problem == IndexFileProblem.None && LoadSet(cost - 1).Problem == IndexFileProblem.Budget && LoadSet(1024).Problem == IndexFileProblem.Budget,
                    $"a resource set ({mode}) is refused when its records and texts would cost more than the caller allows");
                using (var source = new MemoryStream(file, writable: false))
                    check(IndexFile.Load(source, new IndexLoadOptions(protection, IndexUnitKind.Resource, Identity), loadedInto.Limits, loadedInto.Pool).Problem == IndexFileProblem.Kind
                        && Load(loadedInto, file, IndexUnitKind.Database, protection).Problem == IndexFileProblem.Kind,
                        $"a resource set ({mode}) loads only as one, through the catalog");
                original.Connection.Dispose();
                loadedInto.Connection.Dispose();
                check(original.Empty && loadedInto.Empty && loadedInto.Catalog.Sets == 0, $"letting the loaded set ({mode}) go leaves nothing charged");
            }
        var none = new World();
        var bare = await none.Catalog.AcquireAsync(ResourceKey with { Definitions = false }, _ => ResourceObjects(none, definitions: false));
        using var written = new MemoryStream();
        IndexFile.SaveResource(written, bare, DateTime.UtcNow, new IndexSaveOptions(Clear, Identity));
        written.Position = 0;
        var back = IndexFile.LoadResource(written, Clear, Identity, long.MaxValue);
        check(back is { Value.Key.Definitions: false, Header.Definitions: false } && Dump(back.Value.Read.Table) == Dump(bare.Table), "a resource set read without definitions says so in its key and its header");
        check(IndexFile.Save(new MemoryStream(), new DatabaseIndex("x", [], 0, 0, 0), IndexUnitKind.Resource, new IndexSaveOptions(Clear, Identity)) == IndexFileProblem.Unsupported,
            "a read is never saved as a resource set");
        none.Catalog.Release(bare);
    }

    // ---- The budget and the pool ----

    private static async Task Accounting(Action<bool, string> check)
    {
        foreach (var (name, kind, read) in Units)
        {
            // Two connections hold the same unit, one read and one loaded: every text is held once, by two references.
            var world = new World();
            var unit = await read(world);
            world.Hold(unit, kind);
            var (used, stats) = (world.Budget.Used, world.Pool.Stats);
            var file = Save(unit, kind, Sealed);
            var second = new ConnectionIndex(world.Budget, world.Catalog, world.Pool);
            var loaded = Load(world, file, kind, Sealed).Value!;
            check(world.Budget.Used == used + loaded.Bytes && loaded.Bytes == unit.Bytes && world.Pool.Stats == (stats.Texts, 2 * stats.References, stats.Bytes)
                && loaded.Pooled.Zip(unit.Pooled).All(pair => ReferenceEquals(pair.First, pair.Second)),
                $"{name} loaded beside its read holds the pool's own texts: no text twice, one more reference each, and only its records charged again");
            if (kind == IndexUnitKind.Server) second.PutServer(loaded);
            else if (kind == IndexUnitKind.Agent) second.PutAgent(loaded);
            else second.Put(loaded);
            // Dropped in either order, the other keeps every text.
            world.Connection.Dispose();
            check(world.Budget.Used == used && world.Pool.Stats == stats, $"dropping the read of {name} leaves the loaded unit whole");
            second.Dispose();
            check(world.Empty, $"dropping the loaded {name} last gives everything back");

            // The other order, and a load that is never held.
            var later = new World();
            var first = Load(later, file, kind, Sealed).Value!;
            later.Hold(first, kind);
            var twin = await read(later);
            later.Connection.Abandon(twin);
            check(later.Budget.Used == used && later.Pool.Stats == stats, $"a read of {name} beside its loaded unit, then dropped, leaves the loaded one as it was");
            var spare = Load(later, file, kind, Sealed).Value!;
            later.Connection.Abandon(spare);
            check(later.Budget.Used == used && later.Pool.Stats == stats, $"a loaded {name} that is never held gives back what it took");

            // A rebuild's replacement: with the budget full, the load fits in the share of the unit it replaces.
            later.Budget.Limit = later.Budget.Used;
            var replacement = Load(later, file, kind, Sealed, credit: first);
            check(replacement is { Problem: IndexFileProblem.None, Value: { } swap } && swap.Credited > 0 && ReferenceEquals(swap.CreditFrom, first) && later.Budget.Used == later.Budget.Limit + swap.Bytes - swap.Credited
                && (kind == IndexUnitKind.Dataset || swap.Credited == swap.Bytes),
                $"{name} loads as a rebuild's replacement into the share of the read it replaces: {replacement.Problem}, {replacement.Value?.Credited} of {replacement.Value?.Bytes} credited");
            if (replacement.Value is not null)
            {
                later.Hold(replacement.Value, kind);
                check(later.Budget.Used == used && later.Pool.Stats == stats && replacement.Value.CreditFrom is null, $"swapping the loaded {name} in moves the share over: nothing is charged twice");
            }
            check(Load(later, file, kind, Sealed).Problem == IndexFileProblem.Budget && later.Budget.Used == used && later.Pool.Stats == stats, $"without that share the full budget refuses {name}, and nothing is taken");
            later.Connection.Dispose();
            check(later.Empty, $"dropping the replacement of {name} leaves nothing");

            // Refused part way, at every budget from nothing up to what the unit needs: all of it is given back each time.
            // (A SQL Server unit also loads below its full cost, without the definitions the names' reserve refuses.)
            var cost = used;
            var refused = 0;
            var leaner = 0;
            for (var step = 0; step <= 64; step++)
            {
                var tight = new World(new ObjectIndexLimits { DefinitionChars = 2000, MemoryBytes = cost * step / 64, NamesReserveBytes = 0 });
                if (kind == IndexUnitKind.Dataset) tight.Limits.MemoryBytes = cost * step / 64 * 16 / 9 + 1;
                tight.Budget.Limit = tight.Limits.MemoryBytes;
                var attempt = Load(tight, file, kind, Sealed, discovered: false);
                if (attempt.Value is null)
                {
                    refused++;
                    if (attempt.Problem != IndexFileProblem.Budget || !tight.Empty) check(false, $"{name} refused at {step}/64 of its cost answers {attempt.Problem} and leaves {tight.Budget.Used} bytes, {tight.Pool.Count} texts");
                    continue;
                }
                if (attempt.Value.LeftOut > unit.LeftOut) leaner++;
                tight.Hold(attempt.Value, kind);
                tight.Connection.Dispose();
                if (!tight.Empty) check(false, $"{name} loaded at {step}/64 of its cost and dropped leaves {tight.Budget.Used} bytes");
            }
            check(refused > 0 && refused < 65, $"{name} is refused by a budget too small for it, as a value with everything given back ({refused} of 65 budgets refused it, {leaner} loaded it with definitions left out)");
        }
    }

    /// <summary>What a load does when the unit does not fit whole: definitions give way to names as a read's do, and the caller
    /// may load it without its children, which is then the unit a read without children makes.</summary>
    private static async Task Fallbacks(Action<bool, string> check)
    {
        // SQL Server: a budget with no room above the names' reserve leaves every definition the pool does not hold out.
        {
            var source = new World();
            var unit = await Database(source);
            var file = Save(unit, IndexUnitKind.Database, Clear);
            var world = new World();
            world.Limits.NamesReserveBytes = long.MaxValue / 4;
            var loaded = Load(world, file, IndexUnitKind.Database, Clear).Value!;
            var starved = new World();
            starved.Limits.NamesReserveBytes = long.MaxValue / 4;
            var live = await Database(starved);
            check(loaded.Modules == 0 && loaded.LeftOut == unit.Modules + unit.LeftOut && loaded.Cut == live.Cut && loaded.LeftOut == live.LeftOut && loaded.Modules == live.Modules
                && Enumerable.Range(0, loaded.Table.Count).All(at => !loaded.Table.HasDefinition(at) && !loaded.Table.DefinitionCut(at))
                && loaded.Table.Rows().Select(row => row.Label).SequenceEqual(unit.Table.Rows().Select(row => row.Label)),
                $"a database loaded with no room above the names' reserve keeps every name and counts each definition as left out for memory, as its read would: {loaded.Modules} modules, {loaded.Cut} cut, {loaded.LeftOut} left out against {live.Cut} and {live.LeftOut}");
            check(world.Budget.Used == loaded.Bytes + loaded.Pooled.Sum(StringPool.Cost) && loaded.Bytes < unit.Bytes, "a definition left out on load is not charged: not its text, nor its slot");
            world.Connection.Abandon(loaded);
            starved.Connection.Abandon(live);
            source.Connection.Abandon(unit);
            check(world.Empty && starved.Empty && source.Empty, "the starved loads give everything back");
        }

        // SQL Server: loaded without its children, the unit is the one a read without children makes.
        foreach (var definitions in new[] { true, false })
        {
            var source = new World();
            var unit = await Database(source, definitions: definitions);
            var file = Save(unit, IndexUnitKind.Database, Sealed);
            var world = new World();
            var loaded = Load(world, file, IndexUnitKind.Database, Sealed, children: false);
            var liveWorld = new World();
            var live = await Database(liveWorld, children: false, definitions: definitions);
            check(loaded.Value is { ChildrenLeftOut: true, Table.Details: null } bare && bare.Table.Rows().SequenceEqual(live.Table.Rows()) && (bare.Modules, bare.Cut, bare.LeftOut) == (live.Modules, live.Cut, live.LeftOut)
                && bare.Table.Rows().All(row => row.Kind is not ("column" or "index" or "statistic" or "parameter")) && bare.Table.Rows().Any(row => row.Kind == "trigger") && bare.Table.Rows().Any(row => row.Kind == "key")
                && bare.DefinitionsLeftOut == !definitions && bare.CaseSensitive == false && bare.DottedI,
                $"a database loaded without its children is the read without children (definitions {definitions}): the same objects, keys, constraints and triggers, no columns, indexes, statistics, parameters or details, marked CHILDREN_LEFT_OUT: {loaded.Problem}");
            if (loaded.Value is { } held)
            {
                check(world.Budget.Used == held.Bytes + held.Pooled.Sum(StringPool.Cost) && held.Bytes == held.Table.Count * IndexMemory.RecordBytes + held.Pooled.Length * IndexMemory.SlotBytes
                    && world.Pool.Count == held.Pooled.Length && held.Pooled.Length <= live.Pooled.Length,
                    "a load without children holds and is charged only what it keeps: its entries, and the texts they name");
                world.Hold(held, IndexUnitKind.Database);
                liveWorld.Hold(live, IndexUnitKind.Database);
                var (mine, theirs) = (Searches(world) + Lookups(world, readAt: false), Searches(liveWorld) + Lookups(liveWorld, readAt: false));
                check(mine == theirs, "searches and lookups of a database loaded without its children answer as the read without children does" + Difference(theirs, mine));
            }
            // A budget that holds exactly the read without children holds the load without children: what the load reads past
            // (the columns and their names, several times the entries it keeps) asks nothing of the budget.
            var exact = new World(new ObjectIndexLimits { DefinitionChars = 2000, MemoryBytes = liveWorld.Budget.Used, NamesReserveBytes = 0 });
            var fitted = Load(exact, file, IndexUnitKind.Database, Sealed, children: false);
            check(fitted.Value is not null && exact.Budget.Used <= exact.Budget.Limit && Load(exact, file, IndexUnitKind.Database, Sealed).Problem == IndexFileProblem.Budget,
                $"a budget just large enough for the read without children takes the load without children (definitions {definitions}), and refuses the whole unit: {fitted.Problem}");
            if (fitted.Value is not null) exact.Connection.Abandon(fitted.Value);
            world.Connection.Dispose();
            liveWorld.Connection.Dispose();
            source.Connection.Abandon(unit);
            check(world.Empty && liveWorld.Empty && exact.Empty, "the loads without children give everything back");
        }

        // A read kept after it failed part way (KeepPartial): every row still waiting for its parent was charged and then left
        // out, so its charge is far above its content. It is saved with the most a load believes, and loads.
        {
            var world = new World();
            var children = Enumerable.Range(0, 6000).Select(at => new object?[] { 100 + at, "dbo", "ck_amount", "C", At, 10, false, (byte)0, null });
            var broken = new SearchCostChecks.Batch([
                Rows([("id", typeof(int)), ("schema", typeof(string)), ("name", typeof(string)), ("type", typeof(string)), ("modified", typeof(DateTime)), ("parent", typeof(int)),
                    ("system", typeof(bool)), ("variant", typeof(byte)), ("current", typeof(int))], [[10, "dbo", "Orders", "U", At, 0, false, (byte)0, null], .. children])
            ]) { FailAtResult = 1 };
            var reader = new DatabaseReader("Sales", world.Limits, world.Pool);
            try { await reader.ReadAsync(broken, false, CancellationToken.None); }
            catch (InvalidOperationException) { }
            DatabaseIndex? partial = null;
            ObjectSearchService.KeepPartial(reader, held: false, value => partial = value);
            var file = Save(partial!, IndexUnitKind.Database, Sealed);
            var header = Header(file, Sealed);
            var into = new World();
            var loaded = Load(into, file, IndexUnitKind.Database, Sealed);
            check(partial is { FailedPart: true, Table.Count: 1 } && partial.Bytes > 6000 * IndexMemory.RecordBytes && header.MemoryBytes < partial.Bytes && header.MemoryBytes > 64 * 1024
                && loaded.Value is { FailedPart: true } kept && kept.Bytes == header.MemoryBytes && kept.Table.Rows().SequenceEqual(partial.Table.Rows()) && into.Budget.Used == kept.Bytes + kept.Pooled.Sum(StringPool.Cost),
                $"a read kept after failing part way saves and loads, marked as failed part way, its charge stated as the most a load believes: {loaded.Problem}, {partial?.Bytes} stated as {header.MemoryBytes}");
            if (loaded.Value is not null) into.Connection.Abandon(loaded.Value);
            world.Connection.Abandon(partial!);
            check(world.Empty && into.Empty, "and both give everything back");
        }

        // BigQuery: the floors. Whatever is free, a dataset's columns must leave the details' floor free, and its names the
        // names' floor; a dataset that does not fit whole loads without its columns, and one that does not fit at all is refused.
        {
            var source = new World();
            var unit = Dataset(source, DatasetEntries());
            var file = Save(unit, IndexUnitKind.Dataset, Sealed);
            var cost = source.Budget.Used;
            // A limit L leaves BigQuery's names 5L/8 (above the names' floor), a billing or starred project's details 9L/16
            // and a discovered project's L/2.
            static World Of(long limit) => new(new ObjectIndexLimits { DefinitionChars = 2000, MemoryBytes = limit, NamesReserveBytes = limit / 4 });
            var roomy = Of(cost * 4);
            var whole = Load(roomy, file, IndexUnitKind.Dataset, Sealed);
            check(whole.Value is { ChildrenLeftOut: false, Detailed: true } && roomy.Budget.Free >= roomy.Limits.BigQueryDetailsFloorBytes, "a dataset loads whole while its details leave their floor free");
            if (whole.Value is not null) roomy.Connection.Abandon(whole.Value);

            // One and a half times what the dataset needs: more than enough were it not for the details' floor, which leaves
            // its columns 27/32 of what they need. Its names fit above theirs.
            var tight = Of(cost * 3 / 2);
            var refused = Load(tight, file, IndexUnitKind.Dataset, Sealed);
            check(refused.Problem == IndexFileProblem.Budget && tight.Empty && tight.Budget.Free > cost,
                $"a dataset whose columns would dip below the details' floor is refused with memory still free ({tight.Budget.Free} free, {cost} needed), and gives everything back");
            var bare = Load(tight, file, IndexUnitKind.Dataset, Sealed, children: false);
            var liveWorld = new World();
            var live = Dataset(liveWorld, DatasetEntries(), children: false);
            check(bare.Value is { ChildrenLeftOut: true, Detailed: false, Table.Details: null } kept && Dump(kept, readAt: false, texts: false) == Dump(live, readAt: false, texts: false)
                && tight.Budget.Free >= tight.Limits.BigQueryNamesFloorBytes,
                $"loaded without its columns the dataset is the read without columns, above the names' floor: {bare.Problem}" + (bare.Value is null ? "" : Difference(Dump(live, readAt: false, texts: false), Dump(bare.Value, readAt: false, texts: false))));
            if (bare.Value is not null)
            {
                tight.Hold(bare.Value, IndexUnitKind.Dataset);
                liveWorld.Hold(live, IndexUnitKind.Dataset);
                check(Searches(tight) + BigQueryLookups(tight) == Searches(liveWorld) + BigQueryLookups(liveWorld), "and it searches, looks up and reuses as that read does" + Difference(Searches(liveWorld) + BigQueryLookups(liveWorld), Searches(tight) + BigQueryLookups(tight)));
            }
            tight.Connection.Dispose();
            liveWorld.Connection.Dispose();

            // By path, the fallback is the caller's choice: off, the refusal stands; on, the unit says its children were left out.
            var folder = Directory.CreateTempSubdirectory("varia-index-checks-");
            try
            {
                var path = Path.Combine(folder.FullName, "dataset.vidx");
                check(IndexFile.SaveFile(path, unit, IndexUnitKind.Dataset, new IndexSaveOptions(Sealed, Identity)) == IndexFileProblem.None, "the dataset saves to a path");
                var options = new IndexLoadOptions(Sealed, IndexUnitKind.Dataset, Identity, Discovered: false);
                var stands = IndexFile.LoadFile(path, options, tight.Limits, tight.Pool);
                var fallen = IndexFile.LoadFile(path, options, tight.Limits, tight.Pool, childrenFallback: true);
                check(stands.Problem == IndexFileProblem.Budget && fallen.Value is { ChildrenLeftOut: true } && fallen.Header is { Children: true },
                    $"loading from a path falls back to the unit without its children only when asked: {stands.Problem}, {fallen.Problem}");
                if (fallen.Value is not null) tight.Connection.Abandon(fallen.Value);
                // A discovered project's details give way first. With all but 64 bytes below half the limit in use, a discovered
                // project's dataset has no room for its columns, where a billing or starred project's still has a sixteenth of the limit.
                var between = Of(cost * 32);
                between.Budget.Force(between.Budget.Limit / 2 - 64);
                var discovered = Load(between, file, IndexUnitKind.Dataset, Sealed, discovered: true);
                var starred = Load(between, file, IndexUnitKind.Dataset, Sealed, discovered: false);
                check(discovered.Problem == IndexFileProblem.Budget && starred.Value is { ChildrenLeftOut: false },
                    $"a discovered project's dataset is refused its columns where a billing or starred project's still fit: {discovered.Problem}, {starred.Problem}");
                if (starred.Value is not null) between.Connection.Abandon(starred.Value);
                // No room above the names' floor either: nothing of the dataset loads, with or without its columns.
                var names = Dataset(new World(), DatasetEntries(), children: false);
                var full = Of((names.Bytes + names.Pooled.Sum(StringPool.Cost)) / 2);
                check(IndexFile.LoadFile(path, options, full.Limits, full.Pool, childrenFallback: true).Problem == IndexFileProblem.Budget && full.Empty,
                    "a dataset whose names do not fit above the names' floor is refused even without its columns");
            }
            finally { folder.Delete(true); }
            source.Connection.Abandon(unit);
        }

        // BigQuery: a view's text gives way before its columns do, and the object is then not whole, so the next build reads it again.
        {
            var entries = DatasetEntries();
            var view = entries.FindIndex(entry => entry.Name == "daily");
            entries[view] = entries[view] with { Detail = entries[view].Detail! with { Definition = "SELECT 1 AS day -- " + Module("daily") } };
            var source = new World();
            var unit = Dataset(source, entries);
            var at = Enumerable.Range(0, unit.Table.Count).Single(entry => unit.Table.Name(entry) == "daily");
            var text = unit.Table.StoredDefinition(at);
            var file = Save(unit, IndexUnitKind.Dataset, Clear);
            // Room above the billing project's details' floor (9/16 of the limit) for everything but half that text.
            var limit = (long)Math.Ceiling((source.Budget.Used - StringPool.Cost(text!) / 2) * 16 / 9.0);
            var world = new World(new ObjectIndexLimits { DefinitionChars = 2000, MemoryBytes = limit, NamesReserveBytes = limit / 4 });
            var loaded = Load(world, file, IndexUnitKind.Dataset, Clear);
            check(text is PackedText && loaded.Value is { ChildrenLeftOut: false, Detailed: true } kept && kept.LeftOut == unit.LeftOut + 1 && kept.Cut == unit.Cut + 1 && kept.Modules == unit.Modules - 1
                && !kept.Table.HasDefinition(at) && kept.Facts!.Of(at) is { Whole: false, Detailed: true } && unit.Facts!.Of(at) is { Whole: true }
                && kept.Table.Rows().Select(row => row.Label).SequenceEqual(unit.Table.Rows().Select(row => row.Label)) && kept.Table.Details!.TypedCount == unit.Table.Details!.TypedCount
                && !BigQueryEntries.Known(kept, true).ContainsKey(("bqView", "daily")) && BigQueryEntries.Known(unit, true).ContainsKey(("bqView", "daily"))
                && BigQueryEntries.Known(kept, true).Count == BigQueryEntries.Known(unit, true).Count - 1 && world.Budget.Free >= world.Limits.BigQueryDetailsFloorBytes,
                $"a dataset whose view text does not fit above the details' floor loads with its columns and without that text, counted as left out for memory, and the view is read again by the next build: {loaded.Problem}, {loaded.Value?.LeftOut} left out");
            if (loaded.Value is not null) world.Connection.Abandon(loaded.Value);
            source.Connection.Abandon(unit);
            check(world.Empty && source.Empty, "and gives everything back");
        }
    }

    /// <summary>A save never blocks a search of the unit it saves, and reads one consistent picture of it: searches run all the
    /// while a unit is saved over and over, and every file loads to the unit.</summary>
    private static async Task Concurrent(Action<bool, string> check)
    {
        var world = new World();
        var unit = await Database(world, extraTables: 400);
        world.Hold(unit, IndexUnitKind.Database);
        var expected = Searches(world);
        using var stop = new CancellationTokenSource();
        var searching = Enumerable.Range(0, 3).Select(_ => Task.Run(() =>
        {
            var runs = 0;
            while (!stop.IsCancellationRequested)
            {
                if (Searches(world) != expected) return -1;
                runs++;
            }
            return runs;
        })).ToArray();
        var files = new List<byte[]>();
        for (var save = 0; save < 12; save++) files.Add(Save(unit, IndexUnitKind.Database, save % 2 == 0 ? Sealed : Clear));
        stop.Cancel();
        var searched = await Task.WhenAll(searching);
        var dump = Dump(unit);
        var same = true;
        for (var save = 0; save < files.Count; save++)
        {
            var into = new World();
            var loaded = Load(into, files[save], IndexUnitKind.Database, save % 2 == 0 ? Sealed : Clear).Value;
            same &= loaded is not null && Dump(loaded) == dump;
            if (loaded is not null) into.Connection.Abandon(loaded);
        }
        check(searched.All(runs => runs >= 0) && same, $"searches of a unit answer the same while it is saved, and every file saved meanwhile loads to it ({string.Join("+", searched)} searches during 12 saves)");
        // The unit dropped and its texts gone from the pool, a file saved before still loads: a save keeps nothing of the index alive.
        world.Connection.Dispose();
        var later = new World();
        var after = Load(later, files[0], IndexUnitKind.Database, Sealed).Value;
        check(world.Empty && after is not null && Dump(after) == dump, "a file outlives the unit it was saved from");
        if (after is not null) later.Connection.Abandon(after);
    }
}
