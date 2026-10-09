using System.Diagnostics;
using System.Text.Json;
using Varia.Backend.Protocol;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>Live checks of SequentialAccess ingestion into the result store: the SSMS display matrix, huge values, the
/// idle seal, cancellation, and query events. Run only with VARIA_TEST_SQL_SERVER; every object is temporary.</summary>
internal static class LiveResultChecks
{
    /// <summary>A stored result's rows as display text (null for NULL), decoded from its pages as the results worker would.</summary>
    public static List<string?[]> RowsOf(ResultStore store, ResultDescriptor set) => [.. CellsOf(store, set).Select(row => row.Select(cell => cell.Text).ToArray())];

    public static List<PageCell[]> CellsOf(ResultStore store, ResultDescriptor set)
    {
        var stored = store.Find(set.ResultId) ?? throw new InvalidOperationException("Result " + set.ResultId + " is no longer stored.");
        var rows = new List<PageCell[]>();
        foreach (var page in stored.PagesFor(0, int.MaxValue)) rows.AddRange(PageReader.Read(page.Body, stored.Wires).Rows);
        return rows;
    }

    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, ConnectOptions options, JsonSerializerOptions json)
    {
        var store = service.Results;
        var session = Guid.NewGuid().ToString();
        async Task<QueryResult> Run(string sql, RequestContext? context = null, string? sessionId = null, string? connectionId = null, int maxRows = 1000) =>
            (QueryResult)await service.DispatchAsync("query.execute", JsonSerializer.SerializeToElement(
                new QueryArgs(connectionId ?? info.Id, sessionId ?? session, "master", sql, Guid.NewGuid().ToString(), maxRows, 60), json), json, context);
        Task Close(string sessionId) => service.DispatchAsync("query.session.close", JsonSerializer.SerializeToElement(new SessionArgs(sessionId), json), json);
        try
        {
            var result = await Run("SELECT CAST(SERVERPROPERTY('ProductMajorVersion') AS int) AS major;");
            var major = int.Parse(RowsOf(store, result.ResultSets[0])[0][0]!);
            await TypeMatrix(check, store, major, sql => Run(sql));

            result = await Run("SELECT CAST(1 AS sql_variant) AS i, CAST(CAST(1.5 AS decimal(5,2)) AS sql_variant) AS d, CAST(N'abc' AS sql_variant) AS s, CAST(CAST('2026-10-08T12:34:56.123' AS datetime) AS sql_variant) AS t,"
                + " CAST(CAST('6F9619FF-8B86-D011-B42D-00C04FC964FF' AS uniqueidentifier) AS sql_variant) AS g, CAST(0x0102 AS sql_variant) AS b, CAST(CAST(1 AS money) AS sql_variant) AS m, CAST(NULL AS sql_variant) AS n;");
            var variant = RowsOf(store, result.ResultSets[0])[0];
            check(result.ResultSets[0].Columns.All(column => column.Wire == "text")
                && variant.SequenceEqual(["1", "1.50", "abc", "2026-10-08 12:34:56.123", "6F9619FF-8B86-D011-B42D-00C04FC964FF", "0x0102", "1.00", null]),
                "sql_variant values are formatted by their base type: " + string.Join(" | ", variant));

            // TypeSystemVersion 2005 delivers the newer date and time types as nvarchar text.
            var legacy = (ConnectionInfo)await service.DispatchAsync("connections.connect", JsonSerializer.SerializeToElement(options with { Advanced = new(TypeSystemVersion: "SQL Server 2005") }, json), json);
            try
            {
                result = await Run("SELECT CAST('2026-10-08' AS date) AS d, CAST('12:34:56.1234567' AS time(7)) AS t, CAST('2026-10-08T12:34:56.1234567' AS datetime2(7)) AS d2;", sessionId: Guid.NewGuid().ToString(), connectionId: legacy.Id);
                var row = RowsOf(store, result.ResultSets[0])[0];
                check(result.ResultSets[0].Columns.All(column => column.DataType == "nvarchar" && column.Wire == "text") && row.SequenceEqual(["2026-10-08", "12:34:56.1234567", "2026-10-08 12:34:56.1234567"]),
                    "TypeSystemVersion 2005 reads date, time and datetime2 as text: " + string.Join(" | ", row));
            }
            finally { await service.DispatchAsync("connections.disconnect", JsonSerializer.SerializeToElement(new ConnectionArgs(legacy.Id), json), json); }

            // Sequential access streams a huge value only up to its cap: nothing near its full size is materialised.
            GC.Collect();
            using var process = Process.GetCurrentProcess();
            var before = process.WorkingSet64;
            var watch = Stopwatch.StartNew();
            result = await Run("SELECT REPLICATE(CAST(N'x' AS nvarchar(max)), 50000000) AS big, CAST('<a>' + REPLICATE(CAST('y' AS varchar(max)), 3000000) + '</a>' AS xml) AS doc, 7 AS after;");
            process.Refresh();
            var growth = process.WorkingSet64 - before;
            var huge = CellsOf(store, result.ResultSets[0])[0];
            check(result.Status == "completed" && huge[0].Text!.Length == ColumnPlan.TextCap && (huge[0].Flags & PageReader.Truncated) != 0
                && huge[1].Text!.Length == ColumnPlan.DocumentCap && huge[1].Text!.StartsWith("<a>yyy") && (huge[1].Flags & PageReader.Truncated) != 0 && huge[2].Text == "7"
                && result.ResultSets[0].TruncatedCells == 2 && result.ResultSets[0].Columns[1].Role == "xml" && result.Messages.Any(message => message.Contains("display limits")),
                "a 50,000,000-character nvarchar(max) and a 3 MB xml value are stored as truncated prefixes");
            check(growth < 64L * 1024 * 1024, "reading the huge values grew the working set by " + growth / 1024 / 1024 + " MB, under 64 MB (" + watch.ElapsedMilliseconds + " ms)");

            // maxRows 0 stores rows up to the budget only.
            await IdleSeal(check, store, json, sql => Run(sql), (sql, context, sessionId) => Run(sql, context, sessionId, maxRows: 0), Close);

            var cancelled = await Cancelled(CancelReason.User);
            check(cancelled.Status == "cancelled" && cancelled.Error?.Code == "CANCELLED", "a user CANCEL frame cancels the script");
            var expired = await Cancelled(CancelReason.Deadline);
            check(expired.Status == "timedOut" && expired.Error?.Code == "TIMEOUT", "main's deadline backstop (CANCEL reason 2) times the script out");

            async Task<QueryResult> Cancelled(CancelReason reason)
            {
                using var context = new RequestContext(1, "query.execute", RequestLane.Query, 0);
                var running = Run("WAITFOR DELAY '00:00:20';", context, Guid.NewGuid().ToString());
                await Task.Delay(300);
                context.Cancel(reason);
                return await running;
            }

            if (major >= 17)
            {
                result = await Run("SELECT CAST(N'{\"a\":1}' AS json) AS j;");
                var json2025 = RowsOf(store, result.ResultSets[0])[0][0];
                check(result.ResultSets[0].Columns[0].Role == "json" && json2025 == "{\"a\":1}", "SQL Server 2025 json values are read as text");
            }
            else Console.WriteLine("SQL Server 2025 type checks (json, vector) skipped: the server's major version is " + major + ".");
        }
        finally { await Close(session); }
    }

    /// <summary>Every sql-display.json case in one row (the server's version gates newer types), then a row of NULLs.</summary>
    private static async Task TypeMatrix(Action<bool, string> check, ResultStore store, int major, Func<string, Task<QueryResult>> run)
    {
        using var fixture = JsonDocument.Parse(File.ReadAllText(Fixtures.Path("tests/fixtures/sql-display.json")));
        var cases = fixture.RootElement.GetProperty("cases").EnumerateArray().Where(item => !item.TryGetProperty("minMajorVersion", out var min) || min.GetInt32() <= major).ToList();
        var result = await run("SELECT " + string.Join(", ", cases.Select((item, i) => item.GetProperty("sql").GetString() + " AS c" + i))
            + " UNION ALL SELECT " + string.Join(", ", cases.Select(_ => "NULL")) + ";");
        var failures = new List<string>();
        if (result.Status != "completed") failures.Add(result.Error?.Message ?? result.Status);
        else
        {
            var set = result.ResultSets[0];
            var cells = CellsOf(store, set);
            for (var i = 0; i < cases.Count; i++)
            {
                var item = cases[i];
                var wire = item.TryGetProperty("wire", out var expectedWire) ? expectedWire.GetString() : "text";
                var display = item.GetProperty("display").GetString();
                if (set.Columns[i].Wire != wire || cells[0][i].Text != display || cells[0][i].Flags != 0 || cells[1][i].Flags != PageReader.Null)
                    failures.Add(item.GetProperty("type").GetString() + " " + item.GetProperty("sql").GetString() + " gave '" + cells[0][i].Text + "' (" + set.Columns[i].Wire + ", flags " + cells[0][i].Flags + "/" + cells[1][i].Flags + ")");
            }
        }
        check(cases.Count >= 50 && failures.Count == 0, "live values show their SSMS display text (" + cases.Count + " types and NULLs)" + (failures.Count == 0 ? "" : ": " + string.Join("; ", failures)));
    }

    /// <summary>Rows that wait for a lock mid-statement are sealed after 200 ms, so they can be read before the statement
    /// ends. A second session holds a row lock on a uniquely named global temporary table for that.</summary>
    private static async Task IdleSeal(Action<bool, string> check, ResultStore store, JsonSerializerOptions json, Func<string, Task<QueryResult>> run,
        Func<string, RequestContext?, string?, Task<QueryResult>> runIn, Func<string, Task> close)
    {
        var table = "##varia_seal_" + Guid.NewGuid().ToString("N");
        await run("CREATE TABLE " + table + " (id int PRIMARY KEY); INSERT " + table + " SELECT TOP (3000) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) FROM sys.all_objects AS a CROSS JOIN sys.all_objects AS b;");
        var locker = Guid.NewGuid().ToString();
        var reader = Guid.NewGuid().ToString();
        var events = new List<JsonElement>();
        using var context = new RequestContext(1, "query.execute", RequestLane.Query, 0, sendEvent: (_, value, _) => { lock (events) events.Add(JsonSerializer.SerializeToElement(value, json)); });
        long availableWhileBlocked = 0;
        try
        {
            await runIn("BEGIN TRANSACTION; SELECT id FROM " + table + " WITH (XLOCK, ROWLOCK) WHERE id = 3000;", null, locker);
            var running = runIn("SELECT id FROM " + table + " ORDER BY id;", context, reader);
            var watch = Stopwatch.StartNew();
            while (watch.ElapsedMilliseconds < 10_000 && !running.IsCompleted)
            {
                uint? id;
                lock (events) id = events.Where(item => item.GetProperty("type").GetString() == "resultSet.opened").Select(item => (uint?)item.GetProperty("descriptor").GetProperty("resultId").GetUInt32()).FirstOrDefault();
                availableWhileBlocked = id is { } resultId ? store.Find(resultId)?.RowsAvailable ?? 0 : 0;
                if (availableWhileBlocked > PageBuilder.FirstPageRows) break;
                await Task.Delay(50);
            }
            var blocked = !running.IsCompleted;
            await runIn("ROLLBACK;", null, locker);
            var result = await running;
            var kinds = events.Select(item => item.GetProperty("type").GetString()).ToList();
            check(blocked && availableWhileBlocked > PageBuilder.FirstPageRows && result.Status == "completed" && RowsOf(store, result.ResultSets[0]).Count == 3000,
                "rows read before a lock wait are sealed and readable while the statement waits (" + availableWhileBlocked + " rows)");
            check(kinds.First() == "resultSet.opened" && kinds.Last() == "resultSet.closed" && kinds.Count(kind => kind == "resultSet.closed") == 1,
                "query events report the result set as it opens and closes: " + string.Join(", ", kinds.Distinct()));
        }
        finally
        {
            await close(locker);
            await close(reader);
            await run("DROP TABLE IF EXISTS " + table + ";");
        }
    }
}
