using System.Data;
using Varia.Backend.Search;

namespace Varia.Backend.Tests;

/// <summary>Offline checks of what a search and a build spend: hits past the candidate cap are counted without being kept, results
/// are built only for the answered hits, a read past the budget cancels its batch instead of draining it, definitions the budget
/// would refuse stay unread, and one connection reads two databases at once.</summary>
internal static class SearchCostChecks
{
    public static void Run(Action<bool, string> check)
    {
        Candidates(check);
        Reads(check).GetAwaiter().GetResult();
        FanOut(check).GetAwaiter().GetResult();
    }

    private static readonly ObjectIndexStatus Ready = new("ready", 1, 1, 0, 0, 0, [], true);

    private static ObjectSearchResult Search(ConnectionIndex index, string text, bool names, bool definitions, int limit, int candidates) =>
        IndexSearch.Run(index, new(text, false, false, false, names, definitions, null, null, limit), SearchMatcher.Create(text, false, false, false, TimeSpan.FromSeconds(2)).Matcher!,
            new ObjectIndexLimits { Candidates = candidates }, Ready, CancellationToken.None);

    private static void Candidates(Action<bool, string> check)
    {
        var table = new IndexedObject("table", "tables", "dbo", "Orders");
        var column = new IndexedObject("column", "columns", null, "id", "table", "dbo", "Orders");
        check(table.LabelLength == table.Label.Length && column.LabelLength == column.Label.Length && new IndexedObject("login", "logins", null, "sa").LabelLength == 2,
            "a label's length is known without building the label");

        // Thirty partial name matches scanned before the one exact name, with room for five candidates and three hits.
        var many = new List<IndexedObject>();
        for (var at = 0; at < 30; at++) many.Add(new("table", "tables", "dbo", "Orders_" + at.ToString("D2", System.Globalization.CultureInfo.InvariantCulture)));
        many.Add(table);
        var index = new ConnectionIndex(new IndexBudget(1 << 20));
        index.Put(new DatabaseIndex("Sales", [.. many], 0, 0, 0));
        var result = Search(index, "orders", names: true, definitions: false, limit: 3, candidates: 5);
        check(result.Total == 31 && result.Partial && result.Hits.Count == 3, "matches past the candidate cap still count: " + result.Total);
        // Candidates of equal rank keep no order in the queue: whichever of the first five gave way, the rest are from them.
        check(result.Hits[0] is { Label: "dbo.Orders", Range: [4, 6] } && result.Hits.Skip(1).All(hit => string.CompareOrdinal(hit.Label, "dbo.Orders_05") < 0),
            "an exact name scanned past the cap takes a worse candidate's place");

        // Definition-only hits past the cap count too, and the answered ones carry their match count and preview.
        var modules = new List<IndexedObject>();
        for (var at = 0; at < 20; at++)
            modules.Add(new("procedure", "storedProcedures", "dbo", "p" + at.ToString("D2", System.Globalization.CultureInfo.InvariantCulture), Definition: "SELECT needle,\n  needle FROM t"));
        modules.Add(new("procedure", "storedProcedures", "dbo", "needle_finder", Definition: "-- needle"));
        index.Put(new DatabaseIndex("Sales", [.. modules], 0, 0, 0));
        result = Search(index, "needle", names: false, definitions: true, limit: 2, candidates: 4);
        check(result.Total == 21 && result.Partial && result.Hits is [{ Definition: { Matches: 2, Line: 1 } }, { Definition.Matches: 2 }] && result.Hits.All(hit => hit.Range is null),
            "definition hits past the cap count, and the answered ones count their matches");
        result = Search(index, "needle", names: true, definitions: true, limit: 1, candidates: 4);
        check(result.Hits is [{ Label: "dbo.needle_finder", Range: [4, 6], Definition: { Matches: 1, Preview: "-- needle" } }],
            "a name hit still carries its definition's match, found only once it is answered");
        index.Put(new DatabaseIndex("Sales", [table, column, new("table", "tables", "audit", "Ledger")], 0, 0, 0));
        result = Search(index, "dbo.orders.id", names: true, definitions: false, limit: 10, candidates: 10);
        check(result.Hits is [{ Label: "dbo.Orders.id", Range: [0, 13] }], "a dotted search tests each part of the name before it builds the qualified one");
    }

    /// <summary>A batch's rows as SqlClient serves them: closing the reader short of its end reads every row left (counted as
    /// drained), unless the batch was cancelled first; definition reads are counted.</summary>
    private sealed class Batch(DataTable[] tables) : System.Data.Common.DbDataReader
    {
        private readonly DataTableReader inner = new(tables);
        public bool Cancelled;
        public bool FailOnClose;
        public int Drained;
        public int CharReads;

        public override long GetChars(int ordinal, long dataOffset, char[]? buffer, int bufferOffset, int length)
        {
            // As SqlClient serves a string column; DataTableReader's own reads only char[] columns.
            CharReads++;
            var value = inner.GetString(ordinal);
            var count = (int)Math.Max(0, Math.Min(length, value.Length - dataOffset));
            if (buffer is not null) value.CopyTo((int)dataOffset, buffer, bufferOffset, count);
            return count;
        }

        public override void Close()
        {
            if (!inner.IsClosed && !Cancelled)
                do { while (inner.Read()) Drained++; } while (inner.NextResult());
            inner.Close();
            if (FailOnClose) throw new InvalidOperationException("The batch failed as it closed.");
        }

        public override bool Read() => inner.Read();
        public override bool NextResult() => inner.NextResult();
        public override int Depth => inner.Depth;
        public override int FieldCount => inner.FieldCount;
        public override bool HasRows => inner.HasRows;
        public override bool IsClosed => inner.IsClosed;
        public override int RecordsAffected => inner.RecordsAffected;
        public override object this[int ordinal] => inner[ordinal];
        public override object this[string name] => inner[name];
        public override bool GetBoolean(int ordinal) => inner.GetBoolean(ordinal);
        public override byte GetByte(int ordinal) => inner.GetByte(ordinal);
        public override long GetBytes(int ordinal, long dataOffset, byte[]? buffer, int bufferOffset, int length) => inner.GetBytes(ordinal, dataOffset, buffer, bufferOffset, length);
        public override char GetChar(int ordinal) => inner.GetChar(ordinal);
        public override string GetDataTypeName(int ordinal) => inner.GetDataTypeName(ordinal);
        public override DateTime GetDateTime(int ordinal) => inner.GetDateTime(ordinal);
        public override decimal GetDecimal(int ordinal) => inner.GetDecimal(ordinal);
        public override double GetDouble(int ordinal) => inner.GetDouble(ordinal);
        public override System.Collections.IEnumerator GetEnumerator() => inner.GetEnumerator();
        public override Type GetFieldType(int ordinal) => inner.GetFieldType(ordinal);
        public override float GetFloat(int ordinal) => inner.GetFloat(ordinal);
        public override Guid GetGuid(int ordinal) => inner.GetGuid(ordinal);
        public override short GetInt16(int ordinal) => inner.GetInt16(ordinal);
        public override int GetInt32(int ordinal) => inner.GetInt32(ordinal);
        public override long GetInt64(int ordinal) => inner.GetInt64(ordinal);
        public override string GetName(int ordinal) => inner.GetName(ordinal);
        public override int GetOrdinal(string name) => inner.GetOrdinal(name);
        public override string GetString(int ordinal) => inner.GetString(ordinal);
        public override object GetValue(int ordinal) => inner.GetValue(ordinal);
        public override int GetValues(object[] values) => inner.GetValues(values);
        public override bool IsDBNull(int ordinal) => inner.IsDBNull(ordinal);
    }

    private static DataTable Rows((string Name, Type Type)[] columns, IEnumerable<object?[]> rows)
    {
        var table = new DataTable();
        foreach (var (name, type) in columns) table.Columns.Add(name, type);
        foreach (var row in rows) table.Rows.Add([.. row.Select(value => value ?? DBNull.Value)]);
        return table;
    }

    /// <summary>A database batch without children and with definitions: <paramref name="count"/> procedures, each with one.</summary>
    private static Batch Procedures(int count)
    {
        var at = DateTime.UnixEpoch;
        var ids = Enumerable.Range(1, count).ToList();
        return new([
            Rows([("id", typeof(int)), ("schema", typeof(string)), ("name", typeof(string)), ("type", typeof(string)), ("modified", typeof(DateTime)), ("parent", typeof(int)),
                ("system", typeof(bool)), ("variant", typeof(byte)), ("current", typeof(int))], ids.Select(id => new object?[] { id, "dbo", "p" + id, "P", at, 0, false, (byte)0, null })),
            Rows([("id", typeof(int)), ("schema", typeof(string)), ("name", typeof(string)), ("table", typeof(bool)), ("assembly", typeof(bool)), ("object", typeof(int))], []),
            Rows([("code", typeof(string)), ("schema", typeof(string)), ("name", typeof(string)), ("modified", typeof(DateTime)), ("system", typeof(bool))], []),
            Rows([("id", typeof(int)), ("name", typeof(string)), ("modified", typeof(DateTime)), ("system", typeof(bool))], []),
            Rows([("name", typeof(string)), ("modified", typeof(DateTime)), ("text", typeof(string))], []),
            Rows([("id", typeof(int)), ("text", typeof(string))], ids.Select(id => new object?[] { id, "CREATE PROCEDURE dbo.p" + id + " AS SELECT " + id }))
        ]);
    }

    private static async Task Reads(Action<bool, string> check)
    {
        // Too small for 200 procedures: the read stops early, and the batch is cancelled before its reader closes.
        var limits = new ObjectIndexLimits { NamesReserveBytes = 0 };
        var rows = Procedures(200);
        var index = await ObjectSearchService.ReadThenStopAsync<DatabaseIndex>(() => Task.FromResult<System.Data.Common.DbDataReader>(rows),
            read => new DatabaseReader("Sales", limits, new StringPool(new IndexBudget(4096))).ReadAsync(read, true, CancellationToken.None, children: false), () => rows.Cancelled = true, _ => throw new InvalidOperationException("kept"));
        check(index is null && rows.Cancelled && rows.Drained == 0, "a read past the budget cancels its batch, so no row is read after it stopped: " + rows.Drained);
        // The fake drains as SqlClient does when nothing cancels it, so the check above bites.
        var uncancelled = Procedures(200);
        await ObjectSearchService.ReadThenStopAsync<DatabaseIndex>(() => Task.FromResult<System.Data.Common.DbDataReader>(uncancelled),
            read => new DatabaseReader("Sales", limits, new StringPool(new IndexBudget(4096))).ReadAsync(read, true, CancellationToken.None, children: false), () => { }, _ => { });
        check(uncancelled.Drained > 100, "a reader closed short of its end without a cancel drains the rest of the batch");
        var fits = Procedures(3);
        index = await ObjectSearchService.ReadThenStopAsync<DatabaseIndex>(() => Task.FromResult<System.Data.Common.DbDataReader>(fits),
            read => new DatabaseReader("Sales", limits, new StringPool(new IndexBudget(1 << 20))).ReadAsync(read, true, CancellationToken.None, children: false), () => fits.Cancelled = true, _ => { });
        check(index is { Modules: 3, Cut: 0 } && !fits.Cancelled && fits.CharReads > 0, "a read that fits is not cancelled and keeps its definitions");

        // A read that completes is held before its reader closes: an error on close leaves it in the index, its memory
        // accounted for, rather than charged to the shared budget and lost.
        var budget = new IndexBudget(1 << 20);
        var shared = new StringPool(budget);
        var held = new ConnectionIndex(budget, pool: shared);
        var failing = Procedures(3);
        failing.FailOnClose = true;
        var threw = false;
        try
        {
            await ObjectSearchService.ReadThenStopAsync<DatabaseIndex>(() => Task.FromResult<System.Data.Common.DbDataReader>(failing),
                read => new DatabaseReader("Sales", limits, shared).ReadAsync(read, true, CancellationToken.None, children: false), () => { }, held.Put);
        }
        catch (InvalidOperationException) { threw = true; }
        var used = budget.Used;
        held.Dispose();
        check(threw && used > 0 && budget.Used == 0, "a read whose reader fails as it closes is already held, so dropping the index gives back all it took: " + budget.Used);

        // Below the names' reserve the pool refuses every definition, so none is streamed, and each counts as cut.
        var starved = Procedures(3);
        index = await new DatabaseReader("Sales", new ObjectIndexLimits { NamesReserveBytes = 1 << 20 }, new StringPool(new IndexBudget(1 << 20))).ReadAsync(starved, true, CancellationToken.None, children: false);
        check(index is { Modules: 0, Cut: 3 } && index.Objects.Length == 3 && index.Objects.All(item => item.Definition is null) && starved.CharReads == 0,
            "below the names' reserve a definition is left unread and counted as cut");
    }

    private static async Task FanOut(Action<bool, string> check)
    {
        var running = 0;
        var most = 0;
        var ran = 0;
        var both = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var reached = true;
        await ObjectSearchService.ForEachBoundedAsync(["a", "b", "c", "d", "e", "f"], new ObjectIndexLimits().Total, async _ =>
        {
            var now = Interlocked.Increment(ref running);
            InterlockedMax(ref most, now);
            if (now >= 2) both.TrySetResult();
            try { await both.Task.WaitAsync(TimeSpan.FromSeconds(10)); }
            catch (TimeoutException) { reached = false; }
            Interlocked.Increment(ref ran);
            Interlocked.Decrement(ref running);
        }, CancellationToken.None);
        check(reached && most == 2 && ran == 6, "one connection reads two databases at once, and never more: " + most);
    }

    private static void InterlockedMax(ref int target, int value)
    {
        for (var current = Volatile.Read(ref target); value > current; current = Volatile.Read(ref target))
            if (Interlocked.CompareExchange(ref target, value, current) == current) return;
    }
}
