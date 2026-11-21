using Microsoft.Data.SqlClient;
using Varia.Backend.Explorer;
using Varia.Backend.Search;

namespace Varia.Backend.Tests;

/// <summary>Offline checks of the editor's lookup into the index (<see cref="IndexLookup"/>): objects by database, schema and name
/// under the database's case rule, their columns, parameters, indexes, keys and foreign keys in and out, each database's state,
/// and the lookup arrays, charged to the budget on first use and given back with the read.</summary>
internal static class SearchLookupChecks
{
    public static void Run(Action<bool, string> check)
    {
        Sql(check);
        Reads(check).GetAwaiter().GetResult();
        Arrays(check).GetAwaiter().GetResult();
        Cases(check);
        States(check);
        Resource(check);
        Service(check).GetAwaiter().GetResult();
    }

    private static readonly LookupLedger.View Idle = new LookupLedger().Snapshot();

    private static void Sql(Action<bool, string> check)
    {
        var render = new SqlRender(ExplorerCatalog.MaxBand);
        check(new[] { false, true }.All(definitions => new[] { false, true }.All(children => ObjectSearchSql.Batch(render, definitions, children).EndsWith(ObjectSearchSql.CaseSensitive, StringComparison.Ordinal))),
            "every database batch ends with the catalog collation's case test, whatever it reads before it");
        // CATALOG_DEFAULT is the collation object names compare under (a contained database's is fixed, not the database's), and the
        // test reads no catalog row, so no visibility rule can hide the answer.
        check(ObjectSearchSql.CaseSensitive.Contains("COLLATE CATALOG_DEFAULT", StringComparison.Ordinal) && !ObjectSearchSql.CaseSensitive.Contains("FROM", StringComparison.Ordinal),
            "the case test compares under the catalog collation and reads no catalog view");
    }

    private static async Task<(DatabaseIndex Index, IndexBudget Budget, ConnectionIndex Connection, StringPool Pool)> Read(bool? caseSensitive = true, bool children = true, long memory = 1 << 24)
    {
        var budget = new IndexBudget(memory);
        var pool = new StringPool(budget);
        var index = (await new DatabaseReader("Sales", new ObjectIndexLimits(), pool).ReadAsync(SearchDetailChecks.Fixture(children, caseSensitive), false, CancellationToken.None))!;
        var connection = new ConnectionIndex(budget, null, pool);
        connection.Put(index);
        return (index, budget, connection, pool);
    }

    private static async Task Reads(Action<bool, string> check)
    {
        var (index, budget, connection, _) = await Read(caseSensitive: false);
        check(index.CaseSensitive == false && index.DefinitionsLeftOut && (await Read(caseSensitive: null)).Index.CaseSensitive is null && (await Read(caseSensitive: true)).Index.CaseSensitive == true,
            "a read keeps whether its database's names tell case apart (unknown when the batch stopped before saying), and that it was read without definitions");
        // A read that fails part way (here on its last result set) and is kept as it is says what it read too.
        var failing = new DatabaseReader("Sales", new ObjectIndexLimits(), new StringPool(new IndexBudget(1 << 24)));
        Exception? failure = null;
        try { await failing.ReadAsync(Broken(), false, CancellationToken.None); } catch (InvalidCastException error) { failure = error; }
        check(failure is not null && failing.Partial() is { DefinitionsLeftOut: true, CaseSensitive: null } partial && partial.Table.Count > 0,
            "a read kept after it failed part way keeps that it was read without definitions, and its case rule as unknown");
        var lookup = new IndexLookup(connection, budget, false, Idle);
        var orders = lookup.Objects("Sales", "dbo", "Orders");
        check(orders is { Database: { State: LookupState.Partial, Gaps: LookupGaps.DefinitionsLeftOut, CaseSensitive: false }, Value: [{ Kind: "table", Schema: "dbo", Name: "Orders" }] },
            "an object is found by database, schema and name, with its database's state (read without definitions: partial)");
        check(lookup.Objects("sales", "DBO", "orders").Value is [{ Name: "Orders" }] && lookup.Objects("Sales", null, "Orders").Value.Count == 1
            && lookup.Objects("Sales", "dbo", "Orders", new HashSet<string> { "view" }).Value.Count == 0 && lookup.Objects("Sales", "dbo", "Order").Value.Count == 0
            && lookup.Objects("Sales", "dbo", "id").Value.Count == 0,
            "a database whose names ignore case finds them in any case (the database's name too); no schema means any; kinds filter; a child is found only through its object");
        check(lookup.Objects("Elsewhere", "dbo", "Orders") is { Database.State: LookupState.Absent, Value.Count: 0 }, "a database the index does not know is absent, with nothing found");

        var table = orders.Value[0];
        var columns = lookup.Columns(table);
        check(columns.Select(column => column.Name).SequenceEqual(["id", "customer_id", "total", "name", "note", "phone", "owner", "embedding", "unsized"])
            && columns.Select(column => (int)column.Ordinal).SequenceEqual(Enumerable.Range(1, 9)) && columns[2].Type?.TypeText == "decimal(18,2)" && columns[0].Entry.Kind == "column",
            "an object's columns come by column_id with their types: " + string.Join(", ", columns.Select(column => column.Name + " " + column.Ordinal)));
        var procedure = lookup.Objects("Sales", "dbo", "usp_get").Value.Single();
        check(lookup.Parameters(procedure).Select(parameter => (parameter.Name, (int)parameter.Ordinal)).SequenceEqual([("@id", 1), ("@rows", 2), ("@list", 3), ("@vec", 4)])
            && lookup.Columns(procedure).Count == 0 && lookup.Parameters(table).Count == 0,
            "a procedure's parameters come by parameter_id; a table has none, a procedure no columns");
        check(lookup.Objects("Sales", "dbo", "fn_total").Value is [{ Type.TypeText: "decimal(18,2)" } function] && lookup.Parameters(function).Select(parameter => parameter.Name).SequenceEqual(["@x"]),
            "a scalar function answers its return type and its parameters (the return is not one)");

        var indexes = lookup.Indexes(table);
        check(indexes.Count == 3
            && indexes.Single(value => value is { Kind: "key", Subtype: "primary" }) is { Entry.Name: "pk_orders", Columns: [{ Name: "id", ColumnId: 1, Descending: false, Included: false }] }
            && indexes.Single(value => value is { Kind: "index", Entry.Name: "pk_orders" }).Columns is [{ Name: "id" }]
            && indexes.Single(value => value.Entry.Name == "ix_orders_customer").Columns is [{ Name: "customer_id", Descending: true, Included: false }, { Name: "name", Included: true }],
            "a table's indexes and primary key come with their columns by name, descending and included ones marked");
        var customers = lookup.Objects("Sales", "dbo", "Customers").Value.Single();
        check(lookup.Indexes(customers).Select(value => (value.Kind, value.Subtype, value.Entry.Name)).Order().SequenceEqual(new[] { ("index", (string?)"nonclustered", "uq_customers"), ("key", "unique", "uq_customers") }.Order()),
            "a unique key comes with its index: " + string.Join(", ", lookup.Indexes(customers).Select(value => value.Kind + " " + value.Subtype + " " + value.Entry.Name)));

        var keys = lookup.ForeignKeys(table);
        check(keys.Count == 2 && keys.Single(key => key.Entry.Name == "fk_orders_customers") is { Table.Name: "Orders", Referenced: { Name: "Customers" }, Pairs: [("customer_id", "id")] }
            && keys.Single(key => key.Entry.Name == "fk_hidden") is { Referenced: null, Pairs: [("id", null)] },
            "a table's foreign keys come with the table they reference and their column pairs by name; one to a table the login cannot see has no table");
        check(lookup.ReferencedBy(customers) is [{ Entry.Name: "fk_orders_customers", Table.Name: "Orders", Referenced: { Name: "Customers" }, Pairs: [("customer_id", "id")] }]
            && lookup.ReferencedBy(table).Count == 0 && lookup.ForeignKeys(customers).Count == 0,
            "a table answers the foreign keys that reference it, from the referencing table's side");
        var list = lookup.Objects("Sales", "dbo", "List", new HashSet<string> { "tableType" }).Value.Single();
        check(lookup.Columns(list) is [{ Name: "value" }] && lookup.Indexes(list).Any(value => value is { Kind: "key", Subtype: "primary", Columns: [{ Name: "value" }] }),
            "a table type answers its columns and key");
        connection.Dispose();
        check(budget.Used == 0, "dropping the connection gives back the read and its lookup arrays");
    }

    /// <summary>The detail fixture with a case set whose column is not a bit: the read fails on its very last value.</summary>
    private static System.Data.DataTableReader Broken()
    {
        var whole = SearchDetailChecks.Fixture(caseSensitive: true);
        var tables = new List<System.Data.DataTable>();
        while (!whole.IsClosed)
        {
            var table = new System.Data.DataTable();
            table.Load(whole);
            tables.Add(table);
        }
        var wrong = new System.Data.DataTable();
        wrong.Columns.Add("cased", typeof(int));
        wrong.Rows.Add(1);
        tables[^1] = wrong;
        return new System.Data.DataTableReader([.. tables]);
    }

    private static async Task Arrays(Action<bool, string> check)
    {
        var (index, budget, connection, pool) = await Read();
        var before = budget.Used;
        var lookup = new IndexLookup(connection, budget, false, Idle);
        check(index.LookupBytes == 0, "a read builds no lookup arrays until the first lookup");
        lookup.Objects("Sales", "dbo", "Orders");
        var table = index.Table;
        var bytes = TableLookup.BytesFor(table);
        check(bytes == 4 * (table.Count + 1) && index.LookupBytes == bytes && budget.Used == before + bytes,
            "the first lookup charges its arrays to the budget: 4 bytes per entry and per foreign key to a held table");
        lookup.Objects("Sales", "dbo", "Customers");
        check(budget.Used == before + bytes && ReferenceEquals(index.Lookup(budget), index.Lookup(budget)), "later lookups reuse the arrays");
        var detail = IndexMemoryReport.Detail(budget, pool, [connection], []);
        check(detail.RecordBytes == index.Bytes + bytes && detail.RecordBytes + detail.NameBytes + detail.DefinitionBytes == budget.Used && detail.ReadingBytes == 0,
            "the memory report counts the lookup arrays with the records, so nothing shows as reading");
        var arrays = index.Lookup(budget)!;
        var tops = Enumerable.Range(0, table.Count).Where(at => table.Parent(at) < 0).Select(table.Name).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        check(tops.All(name => arrays.Named(name).SequenceEqual(TableLookup.ScanNamed(table, name)) && arrays.Named(name.ToUpperInvariant()).SequenceEqual(TableLookup.ScanNamed(table, name)))
            && Enumerable.Range(0, table.Count).All(at => arrays.Children(at).SequenceEqual(TableLookup.ScanChildren(table, at)) && arrays.Referencing(at).SequenceEqual(TableLookup.ScanReferencing(table, at)))
            && !arrays.Named("Nothing").Any() && !arrays.Children(-1).Any(),
            "the arrays find every name, child and referencing key as a scan of the table does, in entry order");

        // A replacement read gives back the old read's arrays with it; a dropped read builds none.
        var again = (await new DatabaseReader("Sales", new ObjectIndexLimits(), pool).ReadAsync(SearchDetailChecks.Fixture(caseSensitive: true), false, CancellationToken.None))!;
        connection.Put(again);
        check(index.LookupBytes == 0 && index.Lookup(budget) is null && budget.Used == before, "a replaced read gives back its arrays and builds no more: " + budget.Used + " vs " + before);
        connection.Dispose();
        check(budget.Used == 0, "and the connection gives back everything");

        // A budget that cannot take the arrays leaves them unbuilt; lookups scan and answer the same.
        var tight = await Read();
        var spare = tight.Budget.Limit - tight.Budget.Used;
        tight.Budget.Force(spare - 3);
        var scanned = new IndexLookup(tight.Connection, tight.Budget, false, Idle);
        var orders = scanned.Objects("Sales", "dbo", "Orders").Value.Single();
        check(tight.Index.LookupBytes == 0 && tight.Index.Lookup(tight.Budget) is null && scanned.Columns(orders).Count == 9 && scanned.ForeignKeys(orders).Count == 2
            && scanned.ReferencedBy(scanned.Objects("Sales", "dbo", "Customers").Value.Single()).Count == 1,
            "a budget that cannot take the arrays builds none, and lookups answer by scanning");
        tight.Budget.Release(spare - 3);
        tight.Connection.Dispose();
        check(tight.Budget.Used == 0, "nothing is charged for arrays the budget refused");
    }

    private static DatabaseIndex Held(string database, bool? caseSensitive, DateTime? readAt = null, params IndexedObject[] rows)
    {
        var index = new DatabaseIndex(database, ObjectTable.Of(rows), 0, 0, 0, readAt: readAt) { CaseSensitive = caseSensitive };
        return index;
    }

    private static void Cases(Action<bool, string> check)
    {
        var budget = new IndexBudget(1 << 20);
        var connection = new ConnectionIndex(budget);
        IndexedObject Table(string schema, string name) => new("table", "tables", schema, name);
        connection.Put(Held("Cased", true, null, Table("dbo", "Item"), Table("dbo", "ITEM"), Table("Sales", "item")));
        connection.Put(Held("Plain", false, null, Table("dbo", "Item")));
        connection.Put(Held("Unknown", null, null, Table("dbo", "Item")));
        var lookup = new IndexLookup(connection, budget, false, Idle);
        check(lookup.Objects("Cased", "dbo", "Item").Value is [{ Name: "Item" }] && lookup.Objects("Cased", "dbo", "ITEM").Value is [{ Name: "ITEM" }]
            && lookup.Objects("Cased", "dbo", "item").Value.Count == 0 && lookup.Objects("Cased", "sales", "item").Value.Count == 0 && lookup.Objects("Cased", "Sales", "item").Value is [{ Schema: "Sales" }]
            && lookup.Objects("Cased", null, "item").Value is [{ Schema: "Sales" }],
            "a database whose names tell case apart finds only the exact name and schema");
        check(lookup.Objects("Plain", "DBO", "ITEM").Value.Count == 1 && lookup.Objects("Unknown", "dbo", "iTeM").Value.Count == 1,
            "one that ignores case, or whose rule is unknown, finds names in any case");
        connection.Put(Held("cased", true, null, Table("dbo", "Other")));
        var two = new IndexLookup(connection, budget, false, Idle);
        check(lookup.Database("CASED").Database == "Cased" && two.Database("CASED").Database == "CASED" && two.Objects("CASED", "dbo", "Item").Database.State == LookupState.Absent
            && two.Database("cased").Held?.Table.Name(0) == "Other" && two.Database("Cased").Held?.Table.Count == 3,
            "a database name that differs only in case from one known name resolves to it, from more than one to none of them; an exact name always wins (a lookup sees the reads held when it was made)");
    }

    private static void States(Action<bool, string> check)
    {
        var budget = new IndexBudget(1 << 20);
        var connection = new ConnectionIndex(budget);
        var first = new DateTime(2026, 11, 20, 11, 0, 0, DateTimeKind.Utc);
        var started = new DateTime(2026, 11, 20, 12, 0, 0, DateTimeKind.Utc);
        var item = new IndexedObject("table", "tables", "dbo", "Item");
        // The first build: Old and Cut read, Timed read then a rebuild of it timed out (its read kept), Broken failed part way (its
        // partial read held), Denied refused, Left read without its children.
        var ledger = new LookupLedger();
        ledger.Start(first);
        ledger.List(["Old", "Timed", "Broken", "Denied", "Left", "Cut"]);
        connection.Put(Held("Old", false, first.AddMinutes(1), item));
        connection.Put(Held("Timed", false, first.AddMinutes(1), item));
        connection.Put(Held("Broken", false, first.AddMinutes(2), item));
        var left = Held("Left", false, first.AddMinutes(1), item);
        left.ChildrenLeftOut = true;
        connection.Put(left);
        connection.Put(new DatabaseIndex("Cut", ObjectTable.Of([item]), 0, 1, 1, readAt: first.AddMinutes(1)));
        foreach (var name in new[] { "Old", "Timed", "Cut" }) ledger.Done(name, null, first.AddMinutes(1));
        ledger.Done("Broken", new("Broken", "CATALOG_ERROR", "failed part way"), first.AddMinutes(2));
        ledger.Done("Denied", new("Denied", "NO_DB_ACCESS", "no access"), first.AddMinutes(2));
        ledger.Done("Left", new("Left", ObjectSearchService.ChildrenLeftOut, "left out"), first.AddMinutes(1));
        ledger.Done("Timed", new("Timed", "TIMEOUT", "too slow"), first.AddMinutes(3));
        LookupDatabase At(bool building, string name) => new IndexLookup(connection, budget, building, ledger.Snapshot()).Database(name);

        check(At(false, "Old") is { State: LookupState.Ready, Gaps: LookupGaps.None, Skip: null } && At(false, "Gone") is { State: LookupState.Absent },
            "after a build, a database it read whole is ready and one it does not know absent");
        check(At(false, "Left") is { State: LookupState.Partial, Gaps: LookupGaps.ChildrenLeftOut, Skip: null } && At(false, "Cut") is { State: LookupState.Partial, Gaps: LookupGaps.DefinitionsCut },
            "a read without its children, or with definitions cut, is partial with the gap named (CHILDREN_LEFT_OUT is not a failure)");
        check(At(false, "Broken") is { State: LookupState.Skipped, Skip.Code: "CATALOG_ERROR", Held: not null } && At(false, "Timed") is { State: LookupState.Skipped, Skip.Code: "TIMEOUT", Held: not null }
            && At(false, "Denied") is { State: LookupState.Skipped, Skip.Code: "NO_DB_ACCESS", Held: null }
            && new IndexLookup(connection, budget, false, ledger.Snapshot()).Objects("Denied", "dbo", "Item") is { Database.State: LookupState.Skipped, Value.Count: 0 },
            "a database whose last read failed is skipped with its reason, a partial or earlier read still answering where there is one");

        // A second build starts and lists the same databases plus a new one.
        ledger.Start(started);
        ledger.List(["Old", "Timed", "Broken", "Denied", "Left", "Cut", "New"]);
        check(At(true, "Old") is { State: LookupState.Building, Held: not null } && At(true, "Broken") is { State: LookupState.Building, Skip.Code: "CATALOG_ERROR" }
            && At(true, "New") is { State: LookupState.Building, Held: null, ReadAt: null } && At(true, "Gone") is { State: LookupState.Absent }
            && new IndexLookup(connection, budget, true, ledger.Snapshot()).Objects("Old", "dbo", "Item").Value.Count == 1,
            "during a build, a database it has not reached is building, its earlier read and skip still there; one it does not know is absent");
        // It is stopped (or its listing fails) after reading only Old again: the databases it did not reach keep their last outcome.
        connection.Put(Held("Old", false, started.AddMinutes(1), item));
        ledger.Done("Old", null, started.AddMinutes(1));
        check(At(true, "Old") is { State: LookupState.Ready } && At(false, "Broken") is { State: LookupState.Skipped, Skip.Code: "CATALOG_ERROR" }
            && At(false, "Denied") is { State: LookupState.Skipped } && At(false, "Timed") is { State: LookupState.Skipped } && At(false, "New") is { State: LookupState.Absent },
            "a stopped build leaves each database it did not reach as its last read left it: a partial read stays skipped, never ready");
        // A later build reads Broken whole and no longer lists Denied.
        connection.Put(Held("Broken", false, started.AddMinutes(5), item));
        ledger.Done("Broken", null, started.AddMinutes(5));
        ledger.List(["Old", "Timed", "Broken", "Left", "Cut", "New"]);
        check(At(false, "Broken") is { State: LookupState.Ready, Skip: null } && At(false, "Denied") is { State: LookupState.Absent, Skip: null },
            "a whole read clears a database's skip, and a listing that no longer names a database drops its skip");
    }

    private static void Resource(Action<bool, string> check)
    {
        var budget = new IndexBudget(1 << 20);
        var connection = new ConnectionIndex(budget);
        var view = new IndexedObject("view", "systemViews", "sys", "objects", System: true, Subtype: "system");
        var system = ObjectTable.Of([view, ObjectSearchChild(view, "name"), ObjectSearchChild(view, "object_id")]);
        connection.PutResource(new ResourceSet(new ResourceKey("17.0.1000.7", 3, 1, null, 1, false), system, 0, 0));
        connection.Put(Held("Sales", false, null, new IndexedObject("table", "tables", "dbo", "Orders")));
        var lookup = new IndexLookup(connection, budget, false, Idle);
        var found = lookup.Objects("Sales", "sys", "objects");
        check(found.Value is [{ Database: "Sales", Source: null, Kind: "view" } objects] && lookup.Columns(objects).Select(column => column.Name).SequenceEqual(["name", "object_id"])
            && lookup.Objects("Elsewhere", "sys", "objects").Value.Count == 0,
            "a system view is found in any database the index holds, from the shared resource set, with its columns; not in an absent database");
    }

    private static IndexedObject ObjectSearchChild(IndexedObject parent, string name) => DatabaseReader.Child(parent, "column", "columns", name)!;

    private sealed class NoHost : IObjectSearchHost
    {
        public ServerProfile Profile(string connectionId) => throw new NotSupportedException();
        public SqlConnection Connection(string connectionId, string? database) => throw new NotSupportedException();
        public Task OpenAsync(SqlConnection connection, CancellationToken token) => throw new NotSupportedException();
    }

    private static async Task Service(Action<bool, string> check)
    {
        using var service = new ObjectSearchService(new NoHost());
        var id = Guid.NewGuid().ToString();
        check(service.Lookup(id) is null, "a connection with no index has no lookup");
        var held = service.Held(id);
        var index = (await new DatabaseReader("Sales", service.Limits, service.Pool).ReadAsync(SearchDetailChecks.Fixture(caseSensitive: false), false, CancellationToken.None))!;
        held.Put(index);
        var lookup = service.Lookup(id)!;
        check(lookup.Objects("Sales", "dbo", "Orders") is { Database.State: LookupState.Partial, Value: [{ Name: "Orders" }] } && index.LookupBytes > 0,
            "the service answers lookups from the connection's index, charging the shared budget");
        service.Forget(id);
        check(service.MemoryUsed == 0 && service.Lookup(id) is null, "a disconnect drops the index and its lookup arrays");
    }
}
