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
        async Task<QueryResult> Run(string sql, RequestContext? context = null, string? sessionId = null, string? connectionId = null, int maxRows = 1000, int maxResultSets = 10) =>
            (QueryResult)await service.DispatchAsync("query.execute", JsonSerializer.SerializeToElement(
                new QueryArgs(connectionId ?? info.Id, sessionId ?? session, "master", sql, Guid.NewGuid().ToString(), maxRows, 60, MaxResultSets: maxResultSets), json), json, context);
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
            // SqlClient reports neither a variant's base type nor its scale, so the date and time family shows 7 digits
            // and smalldatetime shows milliseconds (docs/ipc.md); pinned so a change is visible.
            result = await Run("SELECT CAST(CAST('2026-10-08' AS date) AS sql_variant), CAST(CAST('2026-10-08T12:34:00' AS smalldatetime) AS sql_variant),"
                + " CAST(CAST('2026-10-08T12:34:56.123' AS datetime2(3)) AS sql_variant), CAST(CAST('12:34:56' AS time(0)) AS sql_variant),"
                + " CAST(CAST('2026-10-08T12:34:56+05:30' AS datetimeoffset(0)) AS sql_variant);");
            variant = RowsOf(store, result.ResultSets[0])[0];
            check(variant.SequenceEqual(["2026-10-08 00:00:00.0000000", "2026-10-08 12:34:00.000", "2026-10-08 12:34:56.1230000", "12:34:56.0000000", "2026-10-08 12:34:56.0000000 +05:30"]),
                "sql_variant date and time values show all 7 fractional digits: " + string.Join(" | ", variant));

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

            // xml is serialised as SqlClient's GetChars would, including fragments that start with text.
            result = await Run("SELECT CAST(N'abc' AS xml), CAST(N'é<a b=\"1\"/>' AS xml), (SELECT ',' + name FROM (VALUES ('x'), ('y')) AS t(name) FOR XML PATH(''), TYPE),"
                + " CAST(N'<r><!-- c --><?pi d?><x:e xmlns:x=\"urn:x\">&lt;&amp;</x:e></r>' AS xml);");
            var documents = RowsOf(store, result.ResultSets[0])[0];
            check(documents.SequenceEqual(["abc", "é<a b=\"1\" />", ",x,y", "<r><!-- c --><?pi d?><x:e xmlns:x=\"urn:x\">&lt;&amp;</x:e></r>"]),
                "xml values, including fragments that start with text, keep their serialised text: " + string.Join(" | ", documents));
            // GetChars on xml is quadratic in a large text node (about 12 s for this cell), and nothing checked the token inside it.
            const string bigXml = "DECLARE @x xml = CAST('<a>' + REPLICATE(CAST('y' AS varchar(max)), 8000000) + '</a>' AS xml); ";
            watch.Restart();
            result = await Run(bigXml + "SELECT @x AS doc, 7 AS after FROM (VALUES (1), (2)) AS t(n);");
            var xmlMs = watch.ElapsedMilliseconds;
            check(result.Status == "completed" && RowsOf(store, result.ResultSets[0]).All(row => row[0]!.Length == ColumnPlan.DocumentCap && row[1] == "7") && xmlMs < 10_000,
                "two 8,000,000-character xml cells are read in linear time (" + xmlMs + " ms)");
            using (var context = new RequestContext(1, "query.execute", RequestLane.Query, 0))
            {
                var running = Run(bigXml + "SELECT @x AS doc FROM (SELECT TOP (500) 1 AS n FROM sys.all_objects) AS t;", context, Guid.NewGuid().ToString());
                await Task.Delay(1000);
                watch.Restart();
                context.Cancel(CancelReason.User);
                var stopped = await running;
                var cancelMs = watch.ElapsedMilliseconds;
                check(stopped.Status == "cancelled" && cancelMs < 5000, "a cancel stops a script that is reading large xml cells (" + cancelMs + " ms)");
            }
            await UnreadValues(check, store, (sql, context, maxRows, maxResultSets) => Run(sql, context, Guid.NewGuid().ToString(), maxRows: maxRows, maxResultSets: maxResultSets));

            // maxRows 0 stores rows up to the budget only.
            await IdleSeal(check, store, json, sql => Run(sql), (sql, context, sessionId, maxRows) => Run(sql, context, sessionId, maxRows: maxRows), Close);
            await SkipOffPool(check, store, json, sql => Run(sql), (sql, context, sessionId, maxRows) => Run(sql, context, sessionId, maxRows: maxRows), Close,
                () => service.DispatchAsync("system.health", JsonSerializer.SerializeToElement(new { }, json), json));

            var cancelled = await Cancelled(CancelReason.User);
            check(cancelled.Status == "cancelled" && cancelled.Error?.Code == "CANCELLED", "a user CANCEL frame cancels the script");
            var expired = await Cancelled(CancelReason.Deadline);
            check(expired.Status == "timedOut" && expired.Error?.Code == "TIMEOUT", "main's deadline backstop (CANCEL reason 2) times the script out");

            // 20 collected errors of about 2,000 characters each fill the error text; the stop reason must not push the
            // summary past main's limit of 16,384 characters plus the ellipsis.
            const string noisy = "DECLARE @m nvarchar(2000) = REPLICATE(N'e', 2000), @i int = 0; WHILE @i < 25 BEGIN RAISERROR(@m, 16, 1); SET @i += 1 END;"
                + " RAISERROR('flush', 0, 1) WITH NOWAIT; WAITFOR DELAY '00:00:20';";
            var noisyCancel = await Cancelled(CancelReason.User, noisy, 1500);
            var noisyTimeout = (QueryResult)await service.DispatchAsync("query.execute", JsonSerializer.SerializeToElement(
                new QueryArgs(info.Id, Guid.NewGuid().ToString(), "master", noisy, Guid.NewGuid().ToString(), 1000, 2), json), json);
            check(noisyCancel.Status == "cancelled" && noisyCancel.Error!.Message.StartsWith("The script was cancelled.") && noisyCancel.Error.Message.Length == 16_385
                && noisyTimeout.Status == "timedOut" && noisyTimeout.Error!.Message.StartsWith("The script exceeded its execution timeout.") && noisyTimeout.Error.Message.Length == 16_385,
                "a cancelled or timed-out script keeps its error text within 16,385 characters (" + noisyCancel.Error?.Message.Length + ", " + noisyTimeout.Error?.Message.Length + ")");

            // Ten sets of 4,096 columns with 128-character CJK names would make an 18 MB summary, over the 16 MiB response
            // limit: the sets whose descriptors do not fit are counted as discarded instead.
            var wideSelect = "SELECT " + string.Join(", ", Enumerable.Range(0, 4096).Select(i => "1 AS [" + new string('名', 124) + i.ToString("D4", System.Globalization.CultureInfo.InvariantCulture) + "]")) + ";\nGO 10";
            var wide = await Run(wideSelect);
            var encoded = JsonBridge.Encode(wide, json).Length;
            check(wide.Status == "completed" && wide.ResultSets.Count is > 0 and < 10 && wide.DiscardedResultSets == 10 - wide.ResultSets.Count && encoded < 15 * 1024 * 1024
                && wide.Messages.Any(message => message.Contains("later result sets are not displayed")),
                "result sets whose column lists would overflow the 16 MiB summary are discarded (" + wide.ResultSets.Count + " kept, " + encoded / 1024 + " KiB)");

            async Task<QueryResult> Cancelled(CancelReason reason, string sql = "WAITFOR DELAY '00:00:20';", int delayMs = 300)
            {
                using var context = new RequestContext(1, "query.execute", RequestLane.Query, 0);
                var running = Run(sql, context, Guid.NewGuid().ToString());
                await Task.Delay(delayMs);
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

    /// <summary>The unread rest of a huge value, and every long value of a row that is not stored, is read past in linear time
    /// and bounded memory, and a cancel stops it. SqlClient's ReadAsync would skip them by buffering all of a value first, in
    /// time quadratic in its size (about 20 s and 220 MB for 100,000,000 characters) and ignoring the token.</summary>
    private static async Task UnreadValues(Action<bool, string> check, ResultStore store, Func<string, RequestContext?, int, int, Task<QueryResult>> run)
    {
        const string huge = "REPLICATE(CAST(N'x' AS nvarchar(max)), 100000000)";
        async Task<(QueryResult Result, long Growth, long Ms)> Measure(string sql, int maxRows = 1000, int maxResultSets = 10, int cancelAfterMs = -1)
        {
            GC.Collect();
            var before = Environment.WorkingSet;
            var peak = before;
            using var sampler = new Timer(_ => Interlocked.Exchange(ref peak, Math.Max(Interlocked.Read(ref peak), Environment.WorkingSet)), null, 0, 20);
            using var context = new RequestContext(1, "query.execute", RequestLane.Query, 0);
            var watch = Stopwatch.StartNew();
            var running = run(sql, context, maxRows, maxResultSets);
            if (cancelAfterMs >= 0)
            {
                await Task.Delay(cancelAfterMs);
                watch.Restart();
                context.Cancel(CancelReason.User);
            }
            var result = await running;
            var ms = watch.ElapsedMilliseconds;
            sampler.Change(Timeout.Infinite, Timeout.Infinite);
            return (result, Math.Max(Interlocked.Read(ref peak), Environment.WorkingSet) - before, ms);
        }
        string Measured(long growth, long ms) => "grew the working set by " + growth / 1048576 + " MB, " + ms + " ms";

        var (result, growth, ms) = await Measure("SELECT 7 AS head, " + huge + " AS big;");
        var row = CellsOf(store, result.ResultSets[0])[0];
        check(result.Status == "completed" && row[0].Text == "7" && row[1].Text!.Length == ColumnPlan.TextCap && (row[1].Flags & PageReader.Truncated) != 0
            && growth < 64L * 1024 * 1024 && ms < 15_000, "a truncated 100,000,000-character value in the last column is read past (" + Measured(growth, ms) + ")");
        (result, growth, ms) = await Measure("SELECT " + huge + " AS big, 7 AS after FROM (VALUES (1), (2)) AS t(n);", maxRows: 1);
        check(result.Status == "completed" && result.ResultSets[0] is { RowsRead: 2, RowsStored: 1, Truncated: "rowLimit" } && growth < 64L * 1024 * 1024 && ms < 15_000,
            "a row past maxRows with a 100,000,000-character value is read past (" + Measured(growth, ms) + ")");
        (result, growth, ms) = await Measure("SELECT 1 AS kept; SELECT " + huge + " AS big;", maxResultSets: 1);
        check(result.Status == "completed" && result.ResultSets.Count == 1 && result.DiscardedResultSets == 1 && growth < 64L * 1024 * 1024 && ms < 15_000,
            "a set past maxResultSets with a 100,000,000-character value is read past (" + Measured(growth, ms) + ")");
        foreach (var maxRows in new[] { 1000, 1 })
        {
            (result, growth, ms) = await Measure("SELECT " + huge + " AS big FROM (VALUES (1), (2), (3), (4), (5), (6), (7), (8)) AS t(n);", maxRows: maxRows, cancelAfterMs: 1500);
            check(result.Status == "cancelled" && ms < 5000 && growth < 64L * 1024 * 1024,
                "a cancel stops a script " + (maxRows == 1 ? "skipping rows past maxRows" : "reading truncated cells") + " that hold 100,000,000-character values (" + Measured(growth, ms) + " after the cancel)");
        }

        // GetChars on text and ntext reads the whole value at once.
        (result, growth, ms) = await Measure("DECLARE @t TABLE (id int IDENTITY PRIMARY KEY, n ntext, t text);"
            + " INSERT @t (n, t) VALUES (REPLICATE(CAST(N'é' AS nvarchar(max)), 30000000), REPLICATE(CAST('é' AS varchar(max)), 30000000)), (N'héllo 😀', 'héllo'), (NULL, NULL);"
            + " SELECT n, t, 7 AS after FROM @t ORDER BY id;");
        var rows = CellsOf(store, result.ResultSets[0]);
        check(result.Status == "completed" && rows[0][0].Text == new string('é', ColumnPlan.TextCap) && rows[0][1].Text == new string('é', ColumnPlan.TextCap) && rows[0][2].Text == "7"
            && rows[1].Select(cell => cell.Text).SequenceEqual(["héllo 😀", "héllo", "7"]) && rows[2][0].Flags == PageReader.Null && rows[2][1].Flags == PageReader.Null && growth < 64L * 1024 * 1024,
            "ntext and text values are streamed up to their cap, in their encodings (" + Measured(growth, ms) + ")");

        // SqlClient has no streaming reader for xml under sequential access, so each value is read whole, outside the result
        // budget. That garbage is collected once the reader moves on: left to the runtime, eight of these values peaked at
        // about 480 MB of managed heap, six times one of them.
        async Task<(QueryResult Result, long Peak)> HeapPeak(string sql)
        {
            var before = GC.GetTotalMemory(true);
            var peak = before;
            using var sampler = new Timer(_ => Interlocked.Exchange(ref peak, Math.Max(Interlocked.Read(ref peak), GC.GetTotalMemory(false))), null, 0, 10);
            var result = await run(sql, null, 1000, 10);
            sampler.Change(Timeout.Infinite, Timeout.Infinite);
            return (result, Math.Max(Interlocked.Read(ref peak), GC.GetTotalMemory(false)) - before);
        }
        const string xml = "DECLARE @x xml = CAST('<a>' + REPLICATE(CAST('y' AS varchar(max)), 30000000) + '</a>' AS xml); ";
        var (one, onePeak) = await HeapPeak(xml + "SELECT @x AS doc;");
        var (eight, eightPeak) = await HeapPeak(xml + "SELECT @x AS doc FROM (SELECT TOP (8) 1 AS n FROM sys.all_objects) AS t;");
        check(one.Status == "completed" && eight.Status == "completed" && eight.ResultSets[0].RowsStored == 8 && 2 * eightPeak < 5 * onePeak,
            "eight 30,000,000-character xml values, each read whole, peak at " + eightPeak / 1048576 + " MB of managed heap, against " + onePeak / 1048576 + " MB for one");
    }

    /// <summary>Rows that wait for a lock mid-statement are sealed after 200 ms, so they can be read before the statement
    /// ends. A second session holds a row lock on a uniquely named global temporary table for that. Rows past maxRows in a
    /// set with a long column are read past synchronously, so the rows stored before them are sealed first.</summary>
    private static async Task IdleSeal(Action<bool, string> check, ResultStore store, JsonSerializerOptions json, Func<string, Task<QueryResult>> run,
        Func<string, RequestContext?, string?, int, Task<QueryResult>> runIn, Func<string, Task> close)
    {
        var table = "##varia_seal_" + Guid.NewGuid().ToString("N");
        await run("CREATE TABLE " + table + " (id int PRIMARY KEY); INSERT " + table + " SELECT TOP (3000) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) FROM sys.all_objects AS a CROSS JOIN sys.all_objects AS b;");
        var locker = Guid.NewGuid().ToString();
        var reader = Guid.NewGuid().ToString();
        // Runs the query while the last row's delete is uncommitted, until `rows` are readable or 10 s pass, then rolls the
        // delete back. A locking read skips row locks on pages without uncommitted changes, so an XLOCK taken by a SELECT
        // blocked it only sometimes (a new server let the reader through); a pending delete always makes it wait.
        async Task<(bool Blocked, long Available, QueryResult Result, List<string?> Kinds, long WaitedMs)> WhileLocked(string sql, int maxRows, long rows)
        {
            var events = new List<JsonElement>();
            using var context = new RequestContext(1, "query.execute", RequestLane.Query, 0, sendEvent: (_, value, _) => { lock (events) events.Add(JsonSerializer.SerializeToElement(value, json)); });
            await runIn("BEGIN TRANSACTION; DELETE " + table + " WHERE id = 3000;", null, locker, 0);
            var running = runIn(sql, context, reader, maxRows);
            long available = 0;
            var watch = Stopwatch.StartNew();
            while (watch.ElapsedMilliseconds < 10_000 && !running.IsCompleted)
            {
                uint? id;
                lock (events) id = events.Where(item => item.GetProperty("type").GetString() == "resultSet.opened").Select(item => (uint?)item.GetProperty("descriptor").GetProperty("resultId").GetUInt32()).FirstOrDefault();
                available = id is { } resultId ? store.Find(resultId)?.RowsAvailable ?? 0 : 0;
                if (available >= rows) break;
                await Task.Delay(50);
            }
            var blocked = !running.IsCompleted;
            await runIn("ROLLBACK;", null, locker, 0);
            var result = await running;
            lock (events) return (blocked, available, result, [.. events.Select(item => item.GetProperty("type").GetString())], watch.ElapsedMilliseconds);
        }
        // A failure names what the reader saw, since a lock wait that never came and one that hid every row look alike.
        static string Waited(bool blocked, long available, QueryResult result, List<string?> kinds, long waited) =>
            available + " rows after " + waited + " ms, " + (blocked ? "blocked" : "not blocked") + ", " + result.Status + ", " + result.ResultSets.Count + " sets, events " + string.Join(" ", kinds);
        try
        {
            var (blocked, available, result, kinds, waited) = await WhileLocked("SELECT id FROM " + table + " ORDER BY id;", 0, PageBuilder.FirstPageRows + 1);
            check(blocked && available > PageBuilder.FirstPageRows && result.Status == "completed" && RowsOf(store, result.ResultSets[0]).Count == 3000,
                "rows read before a lock wait are sealed and readable while the statement waits (" + Waited(blocked, available, result, kinds, waited) + ")");
            check(kinds.First() == "resultSet.opened" && kinds.Last() == "resultSet.closed" && kinds.Count(kind => kind == "resultSet.closed") == 1,
                "query events report the result set as it opens and closes: " + string.Join(", ", kinds.Distinct()));
            (blocked, available, result, kinds, waited) = await WhileLocked("SELECT id, CAST(N'x' AS nvarchar(max)) AS note FROM " + table + " ORDER BY id;", 100, 100);
            check(blocked && available == 100 && result.Status == "completed" && result.ResultSets[0] is { RowsRead: 3000, RowsStored: 100 },
                "rows stored before skipped rows with long values are readable while the statement waits (" + Waited(blocked, available, result, kinds, waited) + ")");
        }
        finally
        {
            await close(locker);
            await close(reader);
            await run("DROP TABLE IF EXISTS " + table + ";");
        }
    }

    /// <summary>A row that is not stored, in a set with a long column, is read past with a synchronous Read, which blocks
    /// its thread while the server is slow to send the next row. Such queries waiting on a lock must leave the thread pool
    /// free: on pool threads they delayed every other request, cancels included, by one to three seconds while the pool
    /// slowly added threads.</summary>
    private static async Task SkipOffPool(Action<bool, string> check, ResultStore store, JsonSerializerOptions json, Func<string, Task<QueryResult>> run,
        Func<string, RequestContext?, string?, int, Task<QueryResult>> runIn, Func<string, Task> close, Func<Task<object>> health)
    {
        var table = "##varia_skip_" + Guid.NewGuid().ToString("N");
        await run("CREATE TABLE " + table + " (id int PRIMARY KEY, doc nvarchar(max)); INSERT " + table + " SELECT TOP (1500) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)), N'x' FROM sys.all_objects AS a CROSS JOIN sys.all_objects AS b;");
        var locker = Guid.NewGuid().ToString();
        // More readers than the pool has threads, so that blocking them would need many new ones.
        var readers = Enumerable.Range(0, ThreadPool.ThreadCount + 2 * Environment.ProcessorCount).Select(_ =>
        {
            var opened = new List<uint>();
            var context = new RequestContext(1, "query.execute", RequestLane.Query, 0, sendEvent: (_, value, _) =>
            {
                var item = JsonSerializer.SerializeToElement(value, json);
                if (item.GetProperty("type").GetString() == "resultSet.opened") lock (opened) opened.Add(item.GetProperty("descriptor").GetProperty("resultId").GetUInt32());
            });
            return (Session: Guid.NewGuid().ToString(), Context: context, Opened: opened);
        }).ToList();
        int Skipping() => readers.Count(reader => { lock (reader.Opened) return reader.Opened.Count > 0 && store.Find(reader.Opened[0])?.RowsRead > 100; });
        var running = new List<Task<QueryResult>>();
        try
        {
            // Sessions log in first, so the timed part is only the readers' queries.
            foreach (var reader in readers) await runIn("SELECT 1;", null, reader.Session, 0);
            // An uncommitted delete, not an XLOCK, so that every reader waits on the row (see IdleSeal).
            await runIn("BEGIN TRANSACTION; DELETE " + table + " WHERE id = 1500;", null, locker, 0);
            running.AddRange(readers.Select(reader => runIn("SELECT id, doc FROM " + table + " ORDER BY id;", reader.Context, reader.Session, 100)));
            // Requests arrive as they do in the host, whose reader thread hands each one to the pool with Task.Run. The pool
            // adds threads within seconds, so they are timed while the readers start skipping and for a second after.
            var waits = new List<long>();
            var skipping = 0;
            long cancelWait = 0;
            var sinceCancel = new Stopwatch();
            await Task.Factory.StartNew(() =>
            {
                var watch = Stopwatch.StartNew();
                var probe = new Stopwatch();
                long settled = -1;
                while (watch.ElapsedMilliseconds < 20_000 && (settled < 0 || watch.ElapsedMilliseconds - settled < 1000))
                {
                    probe.Restart();
                    Task.Run(health).Wait();
                    waits.Add(probe.ElapsedMilliseconds);
                    if (settled < 0 && (skipping = Skipping()) == readers.Count) settled = watch.ElapsedMilliseconds;
                    Thread.Sleep(50);
                }
                sinceCancel.Start();
                Task.Run(() =>
                {
                    cancelWait = sinceCancel.ElapsedMilliseconds;
                    foreach (var reader in readers) reader.Context.Cancel(CancelReason.User);
                }).Wait();
            }, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
            var results = await Task.WhenAll(running);
            var cancelMs = sinceCancel.ElapsedMilliseconds;
            check(skipping == readers.Count && waits.Max() < 250 && cancelWait < 250 && cancelMs < 2000 && results.All(result => result.Status == "cancelled"),
                readers.Count + " queries skipping rows with long values while they wait on a lock leave the thread pool free (" + skipping + " skipping; system.health at most "
                + waits.Max() + " ms over " + waits.Count + " calls; cancel started after " + cancelWait + " ms, all cancelled after " + cancelMs + " ms)");
        }
        finally
        {
            await runIn("ROLLBACK;", null, locker, 0);
            await Task.WhenAll(running.Select(task => task.ContinueWith(_ => { }, TaskScheduler.Default)));
            foreach (var reader in readers) reader.Context.Dispose();
            await close(locker);
            foreach (var reader in readers) await close(reader.Session);
            await run("DROP TABLE IF EXISTS " + table + ";");
        }
    }
}
