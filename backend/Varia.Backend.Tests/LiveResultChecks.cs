using System.Diagnostics;
using System.Text;
using System.Data;
using System.Globalization;
using System.Text.Json;
using Microsoft.Data.SqlClient;
using Varia.Backend.Protocol;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>Live checks of SequentialAccess ingestion into the result store: the SSMS display matrix, huge values, the
/// idle seal, cancellation, and query events. Run only with VARIA_TEST_SQL_SERVER; every object is temporary.</summary>
internal static class LiveResultChecks
{
    /// <summary>How long a cancel may take: the floor, or twice a reference this run just measured (the same kind of work,
    /// run to completion), whichever is longer, so parallel runs that slow the machine down slow the bound with it. A cancel
    /// that did not stop the script would take all of it, many times the reference, and still fails.</summary>
    internal static long CancelBound(long floorMs, long referenceMs) => Math.Max(floorMs, 2 * referenceMs);

    /// <summary>Whether a cancelled script stopped before reading all of its one result set's rows. Unlike a time bound, this
    /// does not depend on the machine's load: a cancel that did nothing reads every row, however slowly.</summary>
    internal static bool StoppedEarly(QueryResult result, long rows) => result.Status == "cancelled" && result.ResultSets is [{ RowsRead: var read }] && read < rows;

    /// <summary>Measures once more when the first measurement misses its time bound. On a server other runs share, a
    /// statement now and then waits many seconds on them (with six runs at once, two 8,000,000-character xml cells once took
    /// 10 s instead of 0.3 s, and one 100,000,000-character value 59 s instead of 1 s), while a regression misses both times.</summary>
    internal static async Task<T> OnceMore<T>(string name, long boundMs, Func<T, long> ms, Func<Task<T>> measure, Action<string>? log = null)
    {
        var first = await measure();
        if (ms(first) < boundMs) return first;
        (log ?? Console.WriteLine)("Timing: " + name + " took " + ms(first) + " ms, over its bound of " + boundMs + " ms; measuring it once more.");
        return await measure();
    }

    /// <summary>A stored result's rows as display text (null for NULL), decoded from its pages as the results worker would.</summary>
    public static List<string?[]> RowsOf(ResultStore store, ResultDescriptor set) => [.. CellsOf(store, set).Select(row => row.Select(cell => cell.Text).ToArray())];

    /// <summary>A summary's message texts, whatever their kinds.</summary>
    public static List<string> Texts(QueryResult result) => [.. result.Messages.Select(message => message.Text)];

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
                && result.ResultSets[0].TruncatedCells == 2 && result.ResultSets[0].Columns[1].Role == "xml" && Texts(result).Any(message => message.Contains("display limits")),
                "a 50,000,000-character nvarchar(max) and a 3 MB xml value are stored as truncated prefixes");
            check(growth < 64L * 1024 * 1024, "reading the huge values grew the working set by " + growth / 1024 / 1024 + " MB, under 64 MB (" + watch.ElapsedMilliseconds + " ms)");

            // xml is serialised as SqlClient's GetChars would, including fragments that start with text. SqlClient 7.1's
            // GetXmlReader guesses UTF-8 for those: 'abc' throws, and U+3441 U+3442 (bytes 41 34 42 34) read as "A4B4".
            result = await Run("SELECT CAST(N'abc' AS xml), CAST(N'é<a b=\"1\"/>' AS xml), (SELECT ',' + name FROM (VALUES ('x'), ('y')) AS t(name) FOR XML PATH(''), TYPE),"
                + " CAST(N'<r><!-- c --><?pi d?><x:e xmlns:x=\"urn:x\">&lt;&amp;</x:e></r>' AS xml), CAST(NCHAR(13377) + NCHAR(13378) + N'<a/>' AS xml);");
            var documents = RowsOf(store, result.ResultSets[0])[0];
            check(documents.SequenceEqual(["abc", "é<a b=\"1\" />", ",x,y", "<r><!-- c --><?pi d?><x:e xmlns:x=\"urn:x\">&lt;&amp;</x:e></r>", "\u3441\u3442<a />"]),
                "xml values, including fragments that start with text, keep their serialised text: " + string.Join(" | ", documents));
            // GetChars on xml is quadratic in a large text node (about 12 s for this cell), and nothing checked the token inside it.
            const string bigXml = "DECLARE @x xml = CAST('<a>' + REPLICATE(CAST('y' AS varchar(max)), 8000000) + '</a>' AS xml); ";
            (result, var xmlMs) = await OnceMore("reading two large xml cells", 10_000, item => item.Ms, async () =>
            {
                var started = Stopwatch.StartNew();
                return (Result: await Run(bigXml + "SELECT @x AS doc, 7 AS after FROM (VALUES (1), (2)) AS t(n);"), Ms: started.ElapsedMilliseconds);
            });
            check(result.Status == "completed" && RowsOf(store, result.ResultSets[0]).All(row => row[0]!.Length == ColumnPlan.DocumentCap && row[1] == "7") && xmlMs < 10_000,
                "two 8,000,000-character xml cells are read in linear time (" + xmlMs + " ms)");
            // Uncancelled, the script reads 500 such cells, 250 times the two above.
            var bound = CancelBound(5000, xmlMs);
            var (stopped, cancelMs) = await OnceMore("a cancel of large xml cells", bound, item => item.Ms, async () =>
            {
                using var context = new RequestContext(1, "query.execute", RequestLane.Query, 0);
                var running = Run(bigXml + "SELECT @x AS doc FROM (SELECT TOP (500) 1 AS n FROM sys.all_objects) AS t;", context, Guid.NewGuid().ToString());
                await Task.Delay(1000);
                var since = Stopwatch.StartNew();
                context.Cancel(CancelReason.User);
                return (Result: await running, Ms: since.ElapsedMilliseconds);
            });
            check(stopped.Status == "cancelled" && cancelMs < bound, "a cancel stops a script that is reading large xml cells (" + cancelMs + " ms, under " + bound + ")");
            await UnreadValues(check, store, (sql, context, maxRows, maxResultSets) => Run(sql, context, Guid.NewGuid().ToString(), maxRows: maxRows, maxResultSets: maxResultSets));
            await XmlCellCost(check, options);

            // maxRows 0 stores rows up to the budget only.
            await IdleSeal(check, store, json, sql => Run(sql), (sql, context, sessionId, maxRows) => Run(sql, context, sessionId, maxRows: maxRows), Close);
            // SkipOffPool opens more sessions than the thread pool has threads, which exceeds the session limit on machines with many cores.
            var sessionLimit = service.SessionLimit;
            service.SessionLimit = int.MaxValue;
            try
            {
                await SkipOffPool(check, store, json, sql => Run(sql), (sql, context, sessionId, maxRows) => Run(sql, context, sessionId, maxRows: maxRows), Close,
                    () => service.DispatchAsync("system.health", JsonSerializer.SerializeToElement(new { }, json), json));
            }
            finally { service.SessionLimit = sessionLimit; }

            var cancelled = await Cancelled(CancelReason.User);
            check(cancelled.Status == "cancelled" && cancelled.Error?.Code == "CANCELLED"
                && cancelled.Messages.Contains(new MessageEntry("The script was cancelled. Remaining batches were not executed.", "error")), "a user CANCEL frame cancels the script, and Messages say so in red");
            var expired = await Cancelled(CancelReason.Deadline);
            check(expired.Status == "timedOut" && expired.Error?.Code == "TIMEOUT"
                && expired.Messages.Contains(new MessageEntry("The script exceeded its execution timeout. Remaining batches were not executed.", "error")), "main's deadline backstop (CANCEL reason 2) times the script out");

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

            // 40 sets of 4,096 columns with 128-character CJK names would make a 77 MB summary, over the 16 MiB response limit:
            // sets are kept while their descriptors fit 8 MiB, and the rest are counted as discarded.
            var wideSelect = "SELECT " + string.Join(", ", Enumerable.Range(0, 4096).Select(i => "1 AS [" + new string('名', 124) + i.ToString("D4", System.Globalization.CultureInfo.InvariantCulture) + "]")) + ";\nGO 40";
            var wide = await Run(wideSelect, maxResultSets: 1000);
            var encoded = JsonBridge.Encode(wide, json).Length;
            var fit = wide.ResultSets.Count == 0 ? 0 : (int)(8L * 1024 * 1024 / ColumnPlan.DescriptorBytesOf(wide.ResultSets[0].Columns));
            check(wide.Status == "completed" && wide.ResultSets.Count == fit && fit is > 0 and < 40 && wide.DiscardedResultSets == 40 - fit && encoded < 9 * 1024 * 1024
                && Texts(wide).Contains((40 - fit) + " later result sets are not displayed because their column lists are too large to return. Display limits do not stop script execution."),
                "result sets are kept while their descriptors fit 8 MiB, then discarded with a note (" + wide.ResultSets.Count + " kept, " + encoded / 1024 + " KiB)");
            var many = await Run("SELECT " + string.Join(", ", Enumerable.Range(0, 1000).Select(i => i + " AS c" + i)) + ";\nGO 20", maxResultSets: 1000);
            check(many.Status == "completed" && many.ResultSets.Count == 20 && many.DiscardedResultSets == 0 && many.ResultSets.All(set => set.Columns.Count == 1000),
                "20 sets of 1,000 columns are all kept");
            var overflow = await Run("DECLARE @i int = 0; WHILE @i < 1001 BEGIN SELECT @i AS n; SET @i += 1 END;", maxResultSets: 1000);
            check(overflow.Status == "completed" && overflow.ResultSets.Count == 1000 && overflow.DiscardedResultSets == 1
                && Texts(overflow).Contains("Only the first 1,000 result sets are displayed. Display limits do not stop script execution."),
                "sets past maxResultSets are discarded with a note that groups the count");
            // Past the cap of 1,000 entries, a batch's error is still in Messages, after the truncation note, and the next
            // batch still runs; the summary stays within main's bound.
            var flooded = await Run("DECLARE @i int = 0; WHILE @i < 1200 BEGIN PRINT @i; SET @i += 1 END; SELECT 1/0 AS boom;\nGO\nSELECT 2 AS later;");
            var floodedTexts = Texts(flooded).ToList();
            var errorAt = flooded.Messages.FindIndex(entry => entry.Kind == "error" && entry.Text.StartsWith("Msg 8134, Level 16"));
            check(flooded.Status == "completedWithErrors" && flooded.MessagesTruncated && flooded.Messages.Count <= 1000 + QueryMessages.MaxLateErrors + 8
                && floodedTexts[1000].StartsWith("Messages were truncated") && errorAt > 1000 && flooded.ResultSets.Any(set => set.Columns[0].Name == "later"),
                "an error after 1,000 messages is kept in Messages (" + flooded.Messages.Count + " entries, error at " + errorAt + ")");

            await ResultText(check, service, store, info, options, json, Run, Close);
            await SummaryReports(check, options, json);

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

    /// <summary>The status bar shows each summary's budget, so the backend counts it as reported: closing a run that no
    /// event announced (it grew by less than a report step) still reports the fall to 0, for the second run as for the first.</summary>
    private static async Task SummaryReports(Action<bool, string> check, ConnectOptions options, JsonSerializerOptions json)
    {
        var reports = new List<long>();
        using var service = new SqlService(new ResultStore(1L << 30, 1L << 29), publish: value => { lock (reports) reports.Add(JsonSerializer.SerializeToElement(value, json).GetProperty("usedBytes").GetInt64()); return true; });
        var info = (ConnectionInfo)await service.DispatchAsync("connections.connect", JsonSerializer.SerializeToElement(options, json), json);
        try
        {
            var session = Guid.NewGuid().ToString();
            int Count() { lock (reports) return reports.Count; }
            async Task<(long Shown, long[] Reported)> RunAndClose()
            {
                var result = (QueryResult)await service.DispatchAsync("query.execute", JsonSerializer.SerializeToElement(
                    new QueryArgs(info.Id, session, "master", "SELECT TOP (2000) name FROM sys.all_objects;", Guid.NewGuid().ToString(), 1000, 60), json), json);
                var before = Count();
                await service.DispatchAsync("results.close", JsonSerializer.SerializeToElement(new { resultIds = result.ResultSets.Select(set => set.ResultId).ToArray() }, json), json);
                lock (reports) return (result.Budget.UsedBytes, reports[before..].ToArray());
            }
            var first = await RunAndClose();
            var second = await RunAndClose();
            check(first.Shown > 0 && second.Shown > 0 && first.Reported is [.., 0] && second.Reported is [.., 0],
                "closing a small run reports the fall to 0 after its summary showed " + second.Shown + " bytes, for every run of a session (" + string.Join(", ", first.Reported) + "; " + string.Join(", ", second.Reported) + ")");
        }
        finally { await service.DispatchAsync("connections.disconnect", JsonSerializer.SerializeToElement(new ConnectionArgs(info.Id), json), json); }
    }

    private delegate Task<QueryResult> Runner(string sql, RequestContext? context = null, string? sessionId = null, string? connectionId = null, int maxRows = 1000, int maxResultSets = 10);

    /// <summary>The results grid's backend: FOR XML and FOR JSON as one value, messages with kinds in SSMS's formats, Copy and
    /// Save Results As over stored pages, and the release points (only re-execution and results.close release).</summary>
    private static async Task ResultText(Action<bool, string> check, SqlService service, ResultStore store, ConnectionInfo info, ConnectOptions options, JsonSerializerOptions json,
        Runner run, Func<string, Task> close)
    {
        async Task<T> Call<T>(string method, object args, RequestContext? context = null) => (T)await service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, json), json, context);
        static string Sha(string text) => Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(Encoding.Unicode.GetBytes(text)));

        // FOR XML and FOR JSON: rows of about 2,033 characters joined into one value, equal to the same output cast to text
        // (computed on a second session, since a session's next query releases its results).
        var referenceSession = Guid.NewGuid().ToString();
        foreach (var (role, clause) in new[] { ("xml", "FOR XML PATH('o'), ROOT('objects')"), ("json", "FOR JSON PATH") })
        {
            var select = "SELECT name, object_id, type_desc FROM sys.all_objects ORDER BY object_id " + clause;
            var result = await run(select + ";");
            var reference = await run("DECLARE @t nvarchar(max) = CAST((" + select + ") AS nvarchar(max)); SELECT LEN(@t), CONVERT(varchar(64), HASHBYTES('SHA2_256', @t), 2);", sessionId: referenceSession);
            var set = result.ResultSets[0];
            var cell = CellsOf(store, set)[0][0];
            var expected = RowsOf(store, reference.ResultSets[0])[0];
            check(result.Status == "completed" && set is { RowsRead: 1, RowsStored: 1 } && set.Columns is [{ } column] && column.Role == role && cell.Flags == 0
                && cell.Text!.Length.ToString(System.Globalization.CultureInfo.InvariantCulture) == expected[0] && Sha(cell.Text) == expected[1] && cell.Text.Length > 2033,
                "FOR " + role.ToUpperInvariant() + " output is one " + role + " value equal to the same output cast to nvarchar(max) (" + cell.Text?.Length + " characters)");
        }
        await close(referenceSession);
        var huge = await run("SELECT TOP (60000) a.name, a.object_id, b.object_id AS other FROM sys.all_objects AS a CROSS JOIN sys.all_objects AS b FOR JSON PATH;");
        var hugeCell = CellsOf(store, huge.ResultSets[0])[0][0];
        check(huge.Status == "completed" && huge.ResultSets[0] is { RowsStored: 1, TruncatedCells: 1 } && hugeCell.Text!.Length == ColumnPlan.DocumentCap && (hugeCell.Flags & PageReader.Truncated) != 0,
            "FOR JSON output past 2,097,152 characters keeps that prefix, marked truncated");
        var typed = await run("SELECT TOP (3) name FROM sys.objects ORDER BY object_id FOR XML PATH('o'), TYPE;");
        check(typed.ResultSets[0] is { RowsStored: 1 } && typed.ResultSets[0].Columns[0] is { DataType: "xml", Role: "xml" } && RowsOf(store, typed.ResultSets[0])[0][0]!.StartsWith("<o><name>"),
            "FOR XML ... TYPE arrives as one xml cell");

        // Messages: in order, errors in SSMS's two lines with the line in the whole script, and SSMS's row counts (Varia's own
        // lines, "info") apart from PRINT output ("print"), which opens the Messages strip.
        var messages = await run("SELECT 1 AS one;\nPRINT 'a';\nSELECT 1/0;\nPRINT 'b';\nSELECT TOP (2) name FROM sys.objects;");
        var entries = messages.Messages;
        // A single batch that SQL Server ran to its end after an error says nothing more than SSMS does.
        check(messages.Status == "completedWithErrors" && entries.Count == 5 && entries[0] == new MessageEntry("(1 row affected)", "info") && entries[1] == new MessageEntry("a", "print")
            && entries[2] == new MessageEntry("Msg 8134, Level 16, State 1, Line 3\nDivide by zero error encountered.", "error") && entries[3] == new MessageEntry("b", "print")
            && entries[4] == new MessageEntry("(2 rows affected)", "info") && messages.Error!.Message.StartsWith("Msg 8134, Level 16, State 1, Line 3\nDivide by zero error encountered."),
            "messages keep their order and kinds in SSMS's formats: " + string.Join(" | ", entries.Select(entry => entry.Kind + ":" + entry.Text)));
        var skipped = await run("PRINT 'one';\nGO\nRAISERROR('sev16', 16, 1);\nPRINT 'after';\nGO\nPRINT 'three';");
        check(skipped.Status == "completedWithErrors" && Texts(skipped).SequenceEqual(["one", "Msg 50000, Level 16, State 1, Line 3\nsev16", "after",
                "Batch 2 raised an error; execution continued with the next batch.", "three"]),
            "the batch after an error still runs, and Messages say so: " + string.Join(" | ", Texts(skipped)));
        // SSMS leaves "Changed database context to …" out: USE says only that the commands completed, and the database
        // the toolbar chose is changed to without a message.
        var useSession = Guid.NewGuid().ToString();
        var use = await run("USE tempdb;", sessionId: useSession);
        var back = await run("SELECT 1 AS one;", sessionId: useSession);
        await close(useSession);
        check(use.Status == "completed" && use.Messages.Count == 0 && use.Database == "tempdb" && back.Database == "master" && Texts(back).SequenceEqual(["(1 row affected)"]),
            "database context changes are not messages: " + string.Join(" | ", Texts(use).Concat(Texts(back))));
        check(System.Text.RegularExpressions.Regex.IsMatch(messages.CompletedAt, @"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{7}[+-]\d\d:\d\d$"), "the summary carries the completion time with 7 fractional digits: " + messages.CompletedAt);
        var procedure = await run("CREATE PROCEDURE #varia_fails AS\nBEGIN\n  SELECT 1/0;\nEND;\nGO\nEXEC #varia_fails;");
        check(procedure.Messages.Any(entry => entry.Kind == "error" && entry.Text.StartsWith("Msg 8134, Level 16, State 1, Procedure #varia_fails") && entry.Text.Contains(", Line 3\n")),
            "an error in a procedure names it and its own line: " + string.Join(" | ", procedure.Messages.Select(entry => entry.Text)));

        // Copy and Save Results As read the stored pages; a check-side parser and decoder are the oracles.
        var folder = Directory.CreateTempSubdirectory("varia-live-export-");
        try
        {
            var rows = await run("SELECT TOP (200000) a.object_id AS id, a.name, b.type_desc, CAST(a.object_id AS bigint) * 7 AS big, CASE WHEN b.object_id % 5 = 0 THEN NULL ELSE b.name END AS maybe,"
                + " CAST(N'say \"hi\", ok' AS nvarchar(20)) AS quoted, a.create_date FROM sys.all_objects AS a CROSS JOIN sys.all_objects AS b;", maxRows: 0);
            var set = rows.ResultSets[0];
            check(set.RowsStored == 200_000, "200,000 rows are stored for the export checks");
            var paths = new Dictionary<string, string>();
            foreach (var format in new[] { "csv", "tsv", "json" })
            {
                paths[format] = Path.Combine(folder.FullName, "rows." + format);
                var saved = await Call<ResultsJobResult>("results.export", new ResultsExportArgs(set.ResultId, paths[format], format, true, format == "csv" ? "empty" : "NULL", Guid.NewGuid().ToString("N")));
                check(saved.Rows == 200_000 && saved.Bytes == new FileInfo(paths[format]).Length, "results.export writes " + format + " (" + saved.Bytes / 1024 + " KiB)");
            }
            var records = ParseCsv(Encoding.UTF8.GetString(File.ReadAllBytes(paths["csv"])));
            var decoded = RowsOf(store, set);
            check(records.Count == 200_001 && records.All(record => record.Count == 7) && records[0][0] == "\uFEFFid" && records[1][5] == "say \"hi\", ok"
                && Enumerable.Range(0, 200_000).All(i => records[i + 1][4] == (decoded[i][4] ?? "")), "the CSV parses (RFC 4180) to 200,000 rows of 7 fields, with NULL as an empty field");
            var tsv = Encoding.UTF8.GetString(File.ReadAllBytes(paths["tsv"])).Split("\r\n");
            check(tsv.Length == 200_002 && tsv[^1] == "" && tsv[1] == string.Join('\t', decoded[0].Select(value => value ?? "NULL")), "the tab-delimited text has a header, 200,000 lines and a final CRLF");
            using (var document = JsonDocument.Parse(File.ReadAllBytes(paths["json"])))
                check(document.RootElement.GetArrayLength() == 200_000 && document.RootElement[0].GetProperty("id").ValueKind == JsonValueKind.Number
                    && document.RootElement[0].GetProperty("name").GetString() == decoded[0][1], "the JSON is an array of 200,000 objects with typed numbers");
            var written = new System.Buffers.ArrayBufferWriter<byte>();
            var writer = new ResultTextWriter(written, TextOptions.Export(TextFormat.Csv, true, "empty"), set.Columns);
            int[] all = [.. Enumerable.Range(0, set.Columns.Count)];
            writer.Begin();
            writer.Header(all);
            foreach (var page in store.Find(set.ResultId)!.PagesFor(0, int.MaxValue))
            {
                var view = PageView.Parse(page.Body, all.Length);
                for (var row = 0; row < view.Rows; row++) writer.Row(view, row, all);
            }
            check(written.WrittenSpan.SequenceEqual(File.ReadAllBytes(paths["csv"])), "the exported file holds exactly ResultTextWriter's bytes over the stored pages");

            // Copy 10,000 rows of 8 columns, against the pages decoded by the independent reader.
            var copySource = await run("SELECT TOP (10000) a.object_id, a.name, a.type, a.type_desc, a.schema_id, a.is_ms_shipped, a.create_date, b.object_id AS other"
                + " FROM sys.all_objects AS a CROSS JOIN sys.all_objects AS b;", maxRows: 0);
            var copySet = copySource.ResultSets[0];
            var chunks = new List<byte[]>();
            using var context = new RequestContext(1, "results.copy", RequestLane.Results, 0, 16 * 1024 * 1024, sendData: (owner, _, body) => { chunks.Add(body); owner.Grant((uint)body.Length); });
            var copied = await Call<ResultsJobResult>("results.copy", new ResultsCopyArgs(copySet.ResultId, [new([[0, ResultJobs.MaxSafeInteger]], [[0, 7]])], false, "lf", ResultJobs.MaxCopyBytes), context);
            var text = Encoding.UTF8.GetString([.. chunks.SelectMany(chunk => chunk)]);
            var oracle = string.Join('\n', RowsOf(store, copySet).Select(row => string.Join('\t', row.Select(value => value ?? "NULL"))));
            check(copied is { Rows: 10_000, Partial: false } && text == oracle, "results.copy of 10,000 rows of 8 columns is the decoded pages joined by tabs and line feeds (" + text.Length + " characters)");
        }
        finally { folder.Delete(true); }

        // Release points: closing the session or disconnecting keeps results; the session's next query releases them.
        var session = Guid.NewGuid().ToString();
        var kept = await run("SELECT 1 AS kept;", sessionId: session);
        await close(session);
        check(store.Find(kept.ResultSets[0].ResultId) is not null, "results stay readable after their query session closes");
        var next = await run("SELECT 2 AS next;", sessionId: session);
        check(store.Find(kept.ResultSets[0].ResultId) is null && store.WasReleased(kept.ResultSets[0].ResultId) && store.Find(next.ResultSets[0].ResultId) is not null,
            "the session's next query releases its earlier results");
        await close(session);
        var other = await Call<ConnectionInfo>("connections.connect", options);
        var survivor = await run("SELECT 3 AS survivor;", sessionId: Guid.NewGuid().ToString(), connectionId: other.Id);
        await Call<object>("connections.disconnect", new ConnectionArgs(other.Id));
        check(store.Find(survivor.ResultSets[0].ResultId) is not null && RowsOf(store, survivor.ResultSets[0])[0][0] == "3", "results stay readable after their connection disconnects");
        var closed = await Call<ResultsCloseResult>("results.close", new ResultsCloseArgs([next.ResultSets[0].ResultId, survivor.ResultSets[0].ResultId]));
        check(closed.Closed == 2, "results.close releases them");
    }

    /// <summary>RFC 4180 records: quoted fields may hold commas, doubled quotes and line breaks.</summary>
    private static List<List<string>> ParseCsv(string text)
    {
        var records = new List<List<string>>();
        var record = new List<string>();
        var field = new StringBuilder();
        var quoted = false;
        for (var i = 0; i < text.Length; i++)
        {
            var c = text[i];
            if (quoted)
            {
                if (c != '"') field.Append(c);
                else if (i + 1 < text.Length && text[i + 1] == '"') { field.Append('"'); i++; }
                else quoted = false;
            }
            else if (c == '"') quoted = true;
            else if (c == ',') { record.Add(field.ToString()); field.Clear(); }
            else if (c == '\r' && i + 1 < text.Length && text[i + 1] == '\n')
            {
                record.Add(field.ToString());
                field.Clear();
                records.Add(record);
                record = [];
                i++;
            }
            else field.Append(c);
        }
        if (field.Length > 0 || record.Count > 0) { record.Add(field.ToString()); records.Add(record); }
        return records;
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
        Task<(QueryResult Result, long Growth, long Ms)> Measure(string sql, int maxRows = 1000, int maxResultSets = 10, int cancelAfterMs = -1, long boundMs = long.MaxValue) =>
            OnceMore(cancelAfterMs >= 0 ? "a cancel of 100,000,000-character values" : "reading past a 100,000,000-character value", boundMs, item => item.Ms,
                () => MeasureOnce(sql, maxRows, maxResultSets, cancelAfterMs));
        async Task<(QueryResult Result, long Growth, long Ms)> MeasureOnce(string sql, int maxRows, int maxResultSets, int cancelAfterMs)
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

        var (result, growth, ms) = await Measure("SELECT 7 AS head, " + huge + " AS big;", boundMs: 15_000);
        var row = CellsOf(store, result.ResultSets[0])[0];
        check(result.Status == "completed" && row[0].Text == "7" && row[1].Text!.Length == ColumnPlan.TextCap && (row[1].Flags & PageReader.Truncated) != 0
            && growth < 64L * 1024 * 1024 && ms < 15_000, "a truncated 100,000,000-character value in the last column is read past (" + Measured(growth, ms) + ")");
        var firstValueMs = ms;
        (result, growth, ms) = await Measure("SELECT " + huge + " AS big, 7 AS after FROM (VALUES (1), (2)) AS t(n);", maxRows: 1, boundMs: 15_000);
        check(result.Status == "completed" && result.ResultSets[0] is { RowsRead: 2, RowsStored: 1, Truncated: "rowLimit" } && growth < 64L * 1024 * 1024 && ms < 15_000,
            "a row past maxRows with a 100,000,000-character value is read past (" + Measured(growth, ms) + ")");
        (result, growth, ms) = await Measure("SELECT 1 AS kept; SELECT " + huge + " AS big;", maxResultSets: 1, boundMs: 15_000);
        check(result.Status == "completed" && result.ResultSets.Count == 1 && result.DiscardedResultSets == 1 && growth < 64L * 1024 * 1024 && ms < 15_000,
            "a set past maxResultSets with a 100,000,000-character value is read past (" + Measured(growth, ms) + ")");
        // The faster of two reads of one such value, so one read that stalled on the shared server does not raise the bound.
        var oneValueMs = Math.Min(firstValueMs, ms);
        foreach (var maxRows in new[] { 1000, 1 })
        {
            // Uncancelled, the script reads eight such values, eight times the one above; whatever the load, it stops before the last.
            var bound = CancelBound(5000, oneValueMs);
            (result, growth, ms) = await Measure("SELECT " + huge + " AS big FROM (VALUES (1), (2), (3), (4), (5), (6), (7), (8)) AS t(n);", maxRows: maxRows, cancelAfterMs: 1500, boundMs: bound);
            check(StoppedEarly(result, 8) && ms < bound && growth < 64L * 1024 * 1024, "a cancel stops a script " + (maxRows == 1 ? "skipping rows past maxRows" : "reading truncated cells")
                + " that hold 100,000,000-character values (" + Measured(growth, ms) + " after the cancel, under " + bound + "; " + string.Join(", ", result.ResultSets.Select(set => set.RowsRead))
                + " of 8 rows read)");
        }

        // GetChars on text and ntext reads the whole value at once.
        (result, growth, ms) = await Measure("DECLARE @t TABLE (id int IDENTITY PRIMARY KEY, n ntext, t text);"
            + " INSERT @t (n, t) VALUES (REPLICATE(CAST(N'é' AS nvarchar(max)), 30000000), REPLICATE(CAST('é' AS varchar(max)), 30000000)), (N'héllo 😀', 'héllo'), (NULL, NULL);"
            + " SELECT n, t, 7 AS after FROM @t ORDER BY id;");
        var rows = CellsOf(store, result.ResultSets[0]);
        check(result.Status == "completed" && rows[0][0].Text == new string('é', ColumnPlan.TextCap) && rows[0][1].Text == new string('é', ColumnPlan.TextCap) && rows[0][2].Text == "7"
            && rows[1].Select(cell => cell.Text).SequenceEqual(["héllo 😀", "héllo", "7"]) && rows[2][0].Flags == PageReader.Null && rows[2][1].Flags == PageReader.Null && growth < 64L * 1024 * 1024,
            "ntext and text values are streamed up to their cap, in their encodings (" + Measured(growth, ms) + ")");

        // varchar(max) and varbinary(max) stream like nvarchar(max): GetChars and GetBytes read a PLP value in chunks.
        async Task<(QueryResult Result, long Allocated, long Ms)> Allocating(string sql)
        {
            var before = GC.GetTotalAllocatedBytes(true);
            var watch = Stopwatch.StartNew();
            var result = await run(sql, null, 1000, 10);
            return (result, GC.GetTotalAllocatedBytes(true) - before, watch.ElapsedMilliseconds);
        }
        static string Allocated(long bytes, long ms) => "allocated " + bytes / 1048576 + " MB, " + ms + " ms";
        var (bounded, allocated, boundedMs) = await Allocating("DECLARE @v varchar(max) = REPLICATE(CAST('x' AS varchar(max)), 100000000);"
            + " SELECT @v AS v, CAST(@v AS varbinary(max)) AS b, 7 AS after;");
        row = CellsOf(store, bounded.ResultSets[0])[0];
        check(bounded.Status == "completed" && row[0].Text == new string('x', ColumnPlan.TextCap) && row[1].Text == "0x" + string.Concat(Enumerable.Repeat("78", ColumnPlan.BinaryCap))
            && (row[0].Flags & row[1].Flags & PageReader.Truncated) != 0 && row[2].Text == "7" && allocated < 32L * 1024 * 1024,
            "100,000,000-byte varchar(max) and varbinary(max) values are streamed to their caps (" + Allocated(allocated, boundedMs) + ")");

        // xml streams too: XmlReader parses the column as it arrives and the rest past the cap is read as bytes. Read whole
        // with GetSqlXml, this value allocated about 200 MB.
        var (document, documentAllocated, documentMs) = await Allocating("DECLARE @x xml = CAST('<a>' + REPLICATE(CAST('y' AS varchar(max)), 100000000) + '</a>' AS xml);"
            + " SELECT @x AS doc, 7 AS after;");
        row = CellsOf(store, document.ResultSets[0])[0];
        check(document.Status == "completed" && row[0].Text!.Length == ColumnPlan.DocumentCap && row[0].Text!.StartsWith("<a>yyy") && (row[0].Flags & PageReader.Truncated) != 0
            && row[1].Text == "7" && document.ResultSets[0].TruncatedCells == 1 && documentAllocated < 32L * 1024 * 1024,
            "a 200 MB xml value (100,000,000 characters) is streamed to its 2,097,152-character prefix, marked truncated (" + Allocated(documentAllocated, documentMs) + ")");
        // XmlReader holds a whole attribute before returning its element, so a feed stops it 8 MiB past the last output.
        (document, documentAllocated, documentMs) = await Allocating("DECLARE @x xml = CAST('<r><a b=\"' + REPLICATE(CAST('y' AS varchar(max)), 100000000) + '\"/></r>' AS xml);"
            + " SELECT @x AS doc, 7 AS after;");
        row = CellsOf(store, document.ResultSets[0])[0];
        check(document.Status == "completed" && row[0].Text == "<r" && (row[0].Flags & PageReader.Truncated) != 0 && row[1].Text == "7" && documentAllocated < 64L * 1024 * 1024,
            "an xml value with a 100,000,000-character attribute is cut before that element, marked truncated (" + Allocated(documentAllocated, documentMs) + "): " + row[0].Text);
        // The window counts every byte since the output last grew, so a start tag is cut when its attributes pass it together,
        // and what is kept is only what the writer had written: an unclosed parent start tag, text before it, or nothing.
        static string Ys(int count) => "REPLICATE(CAST('y' AS varchar(max)), " + count + ")";
        (document, documentAllocated, documentMs) = await Allocating("SELECT CAST('<r><a b=\"' + " + Ys(1500000) + " + '\" c=\"' + " + Ys(1500000) + " + '\" d=\"' + " + Ys(1500000) + " + '\"/></r>' AS xml),"
            + " CAST('<a b=\"' + " + Ys(5000000) + " + '\"/>' AS xml), CAST('<r>hello<a b=\"' + " + Ys(5000000) + " + '\"/></r>' AS xml), 7 AS after;");
        row = CellsOf(store, document.ResultSets[0])[0];
        check(document.Status == "completed" && row.Select(cell => cell.Text).SequenceEqual(["<r", "", "<r>hello", "7"]) && row.Take(3).All(cell => (cell.Flags & PageReader.Truncated) != 0)
            && document.ResultSets[0].TruncatedCells == 3, "xml start tags whose attributes pass the window together, or that hold the root or follow text, keep only what was written before them: "
            + string.Join(" | ", row.Select(cell => cell.Text)));
        // The largest node read whole sits just inside the window: XmlReader grows its buffer to hold it, about 50 MB in all.
        (document, documentAllocated, documentMs) = await Allocating("SELECT CAST('<r><!--' + " + Ys(4194000) + " + '--></r>' AS xml) AS doc;");
        row = CellsOf(store, document.ResultSets[0])[0];
        check(document.Status == "completed" && row[0].Text!.Length == ColumnPlan.DocumentCap && row[0].Text!.StartsWith("<r><!--yyy") && (row[0].Flags & PageReader.Truncated) != 0
            && documentAllocated < 64L * 1024 * 1024, "an xml comment just inside the feed's window is read whole and kept to the cap (" + Allocated(documentAllocated, documentMs) + ")");

        // A query can name any nvarchar(max) column like FOR XML output; what the collector does not keep is read past too.
        (result, growth, ms) = await Measure("SELECT " + huge + " AS [XML_F52E2B61-18A1-11d1-B105-00805F49916B];", boundMs: 15_000);
        var joined = CellsOf(store, result.ResultSets[0])[0][0];
        check(result.Status == "completed" && result.ResultSets[0].Columns[0].Role == "xml" && joined.Text!.Length == ColumnPlan.DocumentCap && (joined.Flags & PageReader.Truncated) != 0
            && growth < 64L * 1024 * 1024 && ms < 15_000, "a 100,000,000-character value named like FOR XML output is kept to its cap and read past (" + Measured(growth, ms) + ")");
    }

    /// <summary>Small xml cells reuse the column plan's sink and feed: a fresh pair per cell cost about 16 KB more than reading
    /// each value whole with GetSqlXml. Read here through ColumnPlan alone, on one thread, so only the cells' own cost counts.</summary>
    private static async Task XmlCellCost(Action<bool, string> check, ConnectOptions options)
    {
        const int cells = 20_000;
        await using var connection = new SqlConnection(ConnectionSettings.Build(options).ConnectionString);
        await connection.OpenAsync();
        await using var command = new SqlCommand("SELECT TOP (" + cells + ") CAST(N'<a b=\"1\">x</a>' AS xml) AS doc FROM sys.all_objects AS a CROSS JOIN sys.all_objects AS b;", connection);
        using var reader = command.ExecuteReader(CommandBehavior.SequentialAccess);
        var plan = ColumnPlan.From(reader);
        var builder = new PageBuilder(1, plan.Wires);
        var read = 0;
        var truncated = 0;
        var warned = false;
        Action<string> warn = _ => warned = true;
        var before = GC.GetAllocatedBytesForCurrentThread();
        var watch = Stopwatch.StartNew();
        while (reader.Read())
        {
            builder.BeginRow();
            truncated += plan.ReadRow(reader, builder, warn);
            builder.CommitRow();
            read++;
            if (builder.IsFull) builder.Seal();
        }
        watch.Stop();
        var perCell = (GC.GetAllocatedBytesForCurrentThread() - before) / Math.Max(read, 1);
        Console.WriteLine("xml cells (reported only): " + (read / watch.Elapsed.TotalSeconds).ToString("N0", CultureInfo.InvariantCulture) + " cells/s, "
            + perCell.ToString("N0", CultureInfo.InvariantCulture) + " bytes allocated per cell.");
        // About 28 KB now (XmlReader's and XmlWriter's own buffers), 33 KB through GetSqlXml, 45 KB with a fresh sink per cell.
        check(read == cells && truncated == 0 && !warned && perCell < 36 * 1024, "a small xml cell allocates under 36 KB (" + perCell + " bytes)");
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
            // The batch's own progress may go out on the sink's first tick, before the set opens; it names no set then.
            check(kinds.First(kind => kind != "progress") == "resultSet.opened" && kinds.Last() == "resultSet.closed" && kinds.Count(kind => kind == "resultSet.closed") == 1,
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
