using System.Data;
using Varia.Backend.Explorer;
using Varia.Backend.Search;

namespace Varia.Backend.Tests;

/// <summary>Offline checks of the editor metadata the index keeps with a database's children (<see cref="ObjectDetails"/>): each
/// column's, parameter's and scalar function's type, each index's and key's columns, each foreign key's column pairs and table,
/// charged to the budget like the records, left out with the children, and read for the system objects too.</summary>
internal static class SearchDetailChecks
{
    public static void Run(Action<bool, string> check)
    {
        Sql(check);
        Reads(check).GetAwaiter().GetResult();
        Budget(check).GetAwaiter().GetResult();
        Resources(check).GetAwaiter().GetResult();
    }

    private static DataTable Rows((string Name, Type Type)[] columns, params object?[][] rows)
    {
        var table = new DataTable();
        foreach (var (name, type) in columns) table.Columns.Add(name, type);
        foreach (var row in rows) table.Rows.Add([.. row.Select(value => value ?? DBNull.Value)]);
        return table;
    }

    private static void Sql(Action<bool, string> check)
    {
        var render = new SqlRender(ExplorerCatalog.MaxBand);
        var with = ObjectSearchSql.Batch(render, false, children: true);
        var without = ObjectSearchSql.Batch(render, false, children: false);
        string[] metadata = ["t.system_type_id, t.is_user_defined", "c.user_type_id", "i.index_id", "p.user_type_id", "sys.index_columns AS ic", "sys.key_constraints AS kc", "sys.foreign_key_columns AS fk"];
        check(metadata.All(text => with.Contains(text, StringComparison.Ordinal)) && metadata.All(text => !without.Contains(text, StringComparison.Ordinal)),
            "the batch reads the editor metadata (types, typed columns and parameters, index and key columns, foreign keys) only with the children");
        // sys.index_columns also lists the partitioning column SQL Server adds to an aligned index (key_ordinal 0, not included),
        // which is not one of its columns; XML and spatial index columns (key_ordinal 0 too, not partitioning) stay.
        check(with.Contains("FROM sys.index_columns AS ic WHERE NOT (ic.key_ordinal = 0 AND ic.is_included_column = 0 AND ic.partition_ordinal > 0)", StringComparison.Ordinal),
            "an index's columns leave out the partitioning column SQL Server adds to an aligned index");
        var vector = ObjectSearchSql.Batch(render with { VectorDimensions = true }, false, children: true);
        check(vector.Contains("c.vector_dimensions", StringComparison.Ordinal) && !with.Contains("vector_dimensions", StringComparison.Ordinal)
            && !ObjectSearchSql.ResourceObjects(true).Contains("vector_dimensions", StringComparison.Ordinal),
            "a column's vector dimensions are read only where the server has them");
        check(vector.Contains("p.vector_dimensions", StringComparison.Ordinal) && !with.Contains("p.vector_dimensions", StringComparison.Ordinal),
            "a parameter's vector dimensions are read only where the server has them");
        // The index writes its batch for the server it reads: one with vector dimensions (SQL Server 2025, Azure SQL) reads them.
        check(ObjectSearchService.IndexRender(new ServerProfile(17, null, 3, null, false, true, true, 16)).VectorDimensions
            && !ObjectSearchService.IndexRender(new ServerProfile(16, null, 3, null, false, true, false, 16)).VectorDimensions,
            "the index reads vector dimensions from a server that has them, and not from one that does not");
        check(!with.Contains("p.parameter_id > 0", StringComparison.Ordinal) && ObjectSearchSql.ResourceObjects(false).Contains("p.user_type_id", StringComparison.Ordinal)
            && ObjectSearchSql.ResourceObjects(false).Contains("t.is_user_defined = 0", StringComparison.Ordinal),
            "parameters include a scalar function's return (parameter 0), and the system objects' read types their columns and parameters by the system types");
    }

    private static readonly DateTime At = DateTime.UnixEpoch;

    /// <summary>Two tables with keys, an index with a descending and an included column, a foreign key and one to a table the login
    /// cannot see, a table type with its key, a procedure with output and READONLY parameters, a scalar function with a return type.</summary>
    private static DataTableReader Fixture(bool children = true) => SearchChecks.Batch(children,
        [
            [10, "dbo", "Orders", "U", At, 0, false, (byte)0, null],
            [20, "dbo", "Customers", "U", At, 0, false, (byte)0, null],
            [30, "dbo", "pk_orders", "PK", At, 10, false, (byte)0, null],
            [31, "dbo", "fk_orders_customers", "F", At, 10, false, (byte)0, null],
            [32, "dbo", "uq_customers", "UQ", At, 20, false, (byte)0, null],
            [33, "dbo", "pk_list", "PK", At, 900, false, (byte)0, null],
            [34, "dbo", "fk_hidden", "F", At, 10, false, (byte)0, null],
            [40, "dbo", "usp_get", "P", At, 0, false, (byte)0, null],
            [41, "dbo", "fn_total", "FN", At, 0, false, (byte)0, null]
        ],
        [[257, "dbo", "List", true, false, 900], [258, "dbo", "Phone", false, false, null]],
        [],
        children
            ?
            [
                [10, "id", 1, 56, (short)4, (byte)10, (byte)0, false, true, false, false],
                [10, "customer_id", 2, 56, (short)4, (byte)10, (byte)0, false, false, false, false],
                [10, "total", 3, 106, (short)9, (byte)18, (byte)2, true, false, true, false],
                [10, "name", 4, 231, (short)100, (byte)0, (byte)0, true, false, false, true],
                [10, "note", 5, 231, (short)-1, (byte)0, (byte)0, true, false, false, false],
                [10, "phone", 6, 258, (short)50, (byte)0, (byte)0, true, false, false, false],
                [10, "owner", 7, 256, (short)256, (byte)0, (byte)0, false, false, false, false],
                [10, "embedding", 8, 255, (short)20, (byte)0, (byte)0, true, false, false, false, 3],
                [10, "unsized", 9, 255, (short)20, (byte)0, (byte)0, true, false, false, false, null],
                [20, "id", 1, 56, (short)4, (byte)10, (byte)0, false, false, false, false],
                [900, "value", 1, 56, (short)4, (byte)10, (byte)0, false, false, false, false],
                [998, "hidden_col", 1, 56, (short)4, (byte)10, (byte)0, false, false, false, false]
            ]
            : [],
        children ? [[10, "pk_orders", (byte)1, 1], [10, "ix_orders_customer", (byte)2, 2], [20, "uq_customers", (byte)2, 2], [900, "PK__List", (byte)1, 1], [998, "ix_hidden", (byte)2, 2]] : [],
        [],
        children
            ?
            [
                [40, "@id", false, 1, 56, (short)4, (byte)10, (byte)0, false],
                [40, "@rows", true, 2, 56, (short)4, (byte)10, (byte)0, false],
                [40, "@list", false, 3, 257, (short)-1, (byte)0, (byte)0, true],
                [41, "", false, 0, 106, (short)9, (byte)18, (byte)2, false],
                [41, "@x", false, 1, 56, (short)4, (byte)10, (byte)0, false],
                [40, "@vec", false, 4, 255, (short)20, (byte)0, (byte)0, false, 3]
            ]
            : [],
        allTypes: [.. SearchChecks.SystemTypes, [257, "dbo", "List", (byte)243, true, true], [258, "dbo", "Phone", (byte)231, true, false], [255, "sys", "vector", (byte)165, false, false]],
        indexColumns: [[10, 1, 1, false, false], [10, 2, 2, true, false], [10, 2, 4, false, true], [20, 2, 1, false, false], [900, 1, 1, false, false], [998, 2, 1, false, false]],
        keys: [[30, 10, 1], [32, 20, 2], [33, 900, 1], [999, 10, 1]],
        foreignKeys: [[31, 2, 20, 1], [34, 1, 997, 1], [998, 1, 20, 1]]);

    private static async Task Reads(Action<bool, string> check)
    {
        var budget = new IndexBudget(1 << 24);
        var pool = new StringPool(budget);
        var index = (await new DatabaseReader("Sales", new ObjectIndexLimits(), pool).ReadAsync(Fixture(), false, CancellationToken.None))!;
        var table = index.Table;
        int Find(string name, string? parent = null) => Enumerable.Range(0, table.Count).Single(at => table.Name(at) == name && (parent is null || table.ParentName(at) == parent));
        int Index(string name) => Enumerable.Range(0, table.Count).Single(at => table.Name(at) == name && table.Kind(at) == "index");
        int Key(string name) => Enumerable.Range(0, table.Count).Single(at => table.Name(at) == name && table.Kind(at) == "key");
        string Text(int at) => table.Typed(at)?.TypeText ?? "none";

        check(table.Details is { } details && table.Typed(Find("id", "Orders")) is { TypeName: "int", Ordinal: 1, Flags: TypedFlags.Identity, UserDefinedType: false },
            "a column keeps its type, ordinal and flags (an identity column that is not nullable)");
        check(Text(Find("name")) == "nvarchar(50)" && Text(Find("note")) == "nvarchar(max)" && Text(Find("total")) == "decimal(18,2)" && Text(Find("customer_id")) == "int"
            && Text(Find("owner")) == "sysname" && Text(Find("embedding")) == "vector(3)" && Text(Find("@vec")) == "vector(3)" && Text(Find("unsized")) == "vector" && table.Typed(Find("total"))!.Value.Flags == (TypedFlags.Nullable | TypedFlags.Computed)
            && table.Typed(Find("name"))!.Value.Flags == (TypedFlags.Nullable | TypedFlags.Default),
            "a column's type reads as a script writes it (characters, not bytes; max; precision and scale; a vector's dimensions where the server gave them, a column's or parameter's, never its bytes; sysname by name), with nullable, computed and default: "
            + string.Join(", ", new[] { "name", "note", "total", "owner" }.Select(name => name + " " + Text(Find(name)))));
        check(table.Typed(Find("phone")) is { TypeName: "Phone", TypeSchema: "dbo", UserDefinedType: true, SystemTypeId: 231 } && Text(Find("phone")) == "Phone",
            "an alias type keeps its schema and base type and reads by its name");
        check(table.Typed(Find("fn_total")) is { Ordinal: 0, TypeName: "decimal" } && Text(Find("fn_total")) == "decimal(18,2)" && table.Typed(Find("usp_get")) is null,
            "a scalar function's return type (parameter 0) types the function itself; a procedure has none");
        check(table.Typed(Find("@rows")) is { Flags: TypedFlags.Output, Ordinal: 2 } && table.Typed(Find("@list")) is { TypeName: "List", TableType: true, Flags: TypedFlags.ReadOnly, Ordinal: 3 }
            && table.Typed(Find("@x")) is { Ordinal: 1 } && Enumerable.Range(0, table.Count).All(at => table.Name(at).Length > 0),
            "parameters keep their direction, ordinal and type (a READONLY table-valued one its table type), and the return row adds no parameter");

        check(table.KeyColumns(Index("pk_orders")) is [{ Column: 1, Referenced: 0, Flags: KeyColumnFlags.None }]
            && table.KeyColumns(Index("ix_orders_customer")) is [{ Column: 2, Flags: KeyColumnFlags.Descending }, { Column: 4, Flags: KeyColumnFlags.Included }],
            "an index keeps its columns in key order, descending ones marked, included ones last");
        check(table.KeyColumns(Key("pk_orders")).SequenceEqual(table.KeyColumns(Index("pk_orders"))) && table.KeyColumns(Key("uq_customers")) is [{ Column: 1 }]
            && table.KeyColumns(Key("pk_list")) is [{ Column: 1 }] && table.Referenced(Key("pk_orders")) == -1,
            "a primary or unique key (a table type's too) shares its index's columns");
        check(table.KeyColumns(Key("fk_orders_customers")) is [{ Column: 2, Referenced: 1 }] && table.Referenced(Key("fk_orders_customers")) == Find("Customers")
            && table.KeyColumns(Key("fk_hidden")) is [{ Column: 1, Referenced: 1 }] && table.Referenced(Key("fk_hidden")) == -1,
            "a foreign key pairs its columns with the referenced table's, and names the table (-1 for one the login cannot see)");
        check(table.Details!.TypedCount == Enumerable.Range(0, table.Count).Count(at => table.Typed(at) is not null) && table.Details.TypedCount == 17
            && table.Details.KeyCount == 9 && table.Details.KeyColumns == 7,
            "rows whose object the index does not hold add nothing: " + table.Details.TypedCount + " typed, " + table.Details.KeyCount + " keys, " + table.Details.KeyColumns + " key columns");
        check(budget.Used == index.Bytes + index.Pooled.Sum(StringPool.Cost) && index.Bytes == table.Count * IndexMemory.RecordBytes + index.Pooled.Length * IndexMemory.SlotBytes + table.Details.Bytes,
            "the details are charged to the budget with the records: " + index.Bytes + " for " + table.Count + " entries, " + index.Pooled.Length + " texts and " + table.Details.Bytes + " of details");
        check(table.Details.TextIds().All(id => index.Pooled.Contains(table.Texts[id]!)) && table.NameTexts().Count(name => name) == table.Texts.Count(text => text is string),
            "type names are the pool's texts, kept as names");

        var bare = (await new DatabaseReader("Sales", new ObjectIndexLimits(), new StringPool(new IndexBudget(1 << 24))).ReadAsync(Fixture(children: false), false, CancellationToken.None, children: false))!;
        check(bare.Table.Details is null && bare.Table.Typed(0) is null && bare.Table.KeyColumns(0).Length == 0, "a read without children keeps no details");
        var connection = new ConnectionIndex(budget, pool: pool);
        connection.Put(index);
        connection.Dispose();
        check(budget.Used == 0 && pool.Count == 0, "a disconnect gives the details back with the records");
    }

    /// <summary>The details count toward the budget: a budget that holds the children's records and names but not their details
    /// refuses the read (which is then read again without children), giving back everything it took.</summary>
    private static async Task Budget(Action<bool, string> check)
    {
        var measure = new IndexBudget(1 << 24);
        var full = (await new DatabaseReader("Sales", new ObjectIndexLimits(), new StringPool(measure)).ReadAsync(Fixture(), false, CancellationToken.None))!;
        var tight = new IndexBudget(measure.Used - full.Table.Details!.Bytes);
        var pool = new StringPool(tight);
        var refused = await new DatabaseReader("Sales", new ObjectIndexLimits(), pool).ReadAsync(Fixture(), false, CancellationToken.None);
        check(refused is null && tight.Used == 0 && pool.Count == 0, "a read whose details do not fit answers null and gives back what it took");
    }

    private static async Task Resources(Action<bool, string> check)
    {
        var reader = new DataTableReader([
            Rows([("id", typeof(int)), ("schema", typeof(string)), ("name", typeof(string)), ("type", typeof(string)), ("modified", typeof(DateTime))],
                [-100, "sys", "objects", "V", At], [-200, "sys", "fn_hash", "FN", At], [-300, "sys", "sp_who", "P", At]),
            Rows([("id", typeof(int)), ("schema", typeof(string)), ("name", typeof(string)), ("system", typeof(byte)), ("user", typeof(bool)), ("table", typeof(bool))], SearchChecks.SystemTypes),
            Rows([("id", typeof(int)), ("name", typeof(string)), ("column", typeof(int)), ("type", typeof(int)), ("length", typeof(short)), ("precision", typeof(byte)), ("scale", typeof(byte)),
                ("nullable", typeof(bool)), ("identity", typeof(bool)), ("computed", typeof(bool)), ("default", typeof(bool)), ("dimensions", typeof(int))],
                [-100, "name", 1, 256, (short)256, (byte)0, (byte)0, false, false, false, false, null], [-100, "object_id", 2, 56, (short)4, (byte)10, (byte)0, false, false, false, false, null]),
            Rows([("id", typeof(int)), ("name", typeof(string)), ("output", typeof(bool)), ("parameter", typeof(int)), ("type", typeof(int)), ("length", typeof(short)), ("precision", typeof(byte)),
                ("scale", typeof(byte)), ("readonly", typeof(bool)), ("dimensions", typeof(int))], [-300, "@loginame", false, 1, 256, (short)256, (byte)0, (byte)0, false, null])
        ]);
        var objects = await DatabaseReader.ReadResourceAsync(reader, false, new ObjectIndexLimits(), CancellationToken.None);
        int Find(string name) => Enumerable.Range(0, objects.Count).Single(at => objects.Name(at) == name);
        check(objects.Typed(Find("name")) is { TypeName: "sysname", Ordinal: 1 } && objects.Typed(Find("object_id"))?.TypeText == "int" && objects.Typed(Find("@loginame"))?.TypeText == "sysname",
            "the system objects' columns and parameters keep their types");
        var budget = new IndexBudget(1 << 24);
        var pool = new StringPool(budget);
        var catalog = new ResourceCatalog(pool);
        var set = await catalog.AcquireAsync(new ResourceKey("16.0.4135.4", 3, 2, At, 42, false), _ => Task.FromResult(objects));
        check(set.Bytes == objects.Count * IndexMemory.RecordBytes + objects.Details!.Bytes && budget.Used == set.Bytes + set.Table.Texts.OfType<object>().Sum(StringPool.Cost)
            && set.Table.Typed(Find("name")) is { TypeName: "sysname" }, "a shared system object set is charged its details, and its type names are the pool's");
        catalog.Release(set);
        check(budget.Used == 0 && pool.Count == 0, "letting the set go gives its details back");
    }
}
