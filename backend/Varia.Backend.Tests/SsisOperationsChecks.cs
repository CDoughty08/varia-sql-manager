using System.Text.Json;
using Varia.Backend.Live;
using Varia.Backend.Ssis;

namespace Varia.Backend.Tests;

/// <summary>Offline checks of PR S3, the ssis.operations live source: its catalogue entry against the SSIS catalogue's tiles and
/// tones, its SQL against the live and SSIS lints, its args against main's schema, the filters it binds, and the window's state
/// machine (baseline, settle, open refreshes in turn, rows a refresh no longer finds, the status filter's followed rows, the
/// window that keeps open operations of any age, the limit) and the rows it writes, all without SQL Server.</summary>
internal static class SsisOperationsChecks
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { UnmappedMemberHandling = System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow };
    private static readonly DateTimeOffset Now = new(2026, 10, 26, 12, 0, 0, TimeSpan.FromHours(-5));

    public static void Run(Action<bool, string> check)
    {
        Catalogue(check);
        Lint(check);
        Args(check);
        Window(check);
        Rows(check);
    }

    private static void Catalogue(Action<bool, string> check)
    {
        var live = LiveCatalog.Current;
        var ssis = SsisCatalog.Current;
        var source = live.Sources["ssis.operations"];
        var probe = live.Probes[LiveSql.OperationsProbe];
        check(source.Scope == "ssisdb" && !source.TestOnly && source.Probes.SequenceEqual([LiveSql.OperationsProbe]) && probe.Source == source.Id && LiveService.SsisOperationsSource == source.Id,
            "ssis.operations is a production SSISDB source with one probe, the one LiveSql and the reader name");
        check(probe.Series.Select(series => series.Id).SequenceEqual(ssis.OperationTiles.Select(tile => tile.Series)) && probe.Series.All(series => series.Counter == "gauge")
            && ssis.OperationTiles.All(tile => tile.Statuses.All(ssis.OperationStatuses.ContainsKey)),
            "the probe's series are the SSIS catalogue's tiles, in order, each a gauge over known statuses");
        var table = probe.Tables.Single();
        check(table is { Mode: "snapshot", Key: ["operationId"], Departed: true } && table.Columns.Count == 15 && table.Columns[^1] is { Id: "tone", Role: "tone" }
            && ssis.OperationTones.Values.All(tone => tone is "error" or "warning" or "running" or "muted") && ssis.OperationTones[4] == "error" && ssis.OperationTones[2] == "running"
            && !ssis.OperationTones.ContainsKey(7),
            "the operations table is keyed by id, keeps a departed selection, ends in its tone column, and its tones are live grid tones (failed error, running running, succeeded none)");
        check(ssis.OperationKinds.Keys.SequenceEqual(["execution", "validation", "deploy", "other"]) && ssis.OperationKinds["other"].Count == 0
            && ssis.OperationKinds["execution"].SequenceEqual([200]) && ssis.OperationKinds["validation"].SequenceEqual([300, 301]),
            "the kinds name their operation types, and other names none (it is every type the rest leave out)");
    }

    private static void Lint(Action<bool, string> check)
    {
        var problems = new List<string>();
        foreach (var counts in new[] { false, true })
            foreach (var prologue in new[] { LiveSql.UncommittedPrologue, LiveSql.CommittedPrologue })
            {
                var text = prologue + LiveSql.Operations(counts);
                problems.AddRange(LiveSql.Lint(text).Select(problem => "live " + counts + ": " + problem));
                foreach (var statement in LiveSql.Operations(counts).Split(";\n", StringSplitOptions.RemoveEmptyEntries))
                    problems.AddRange(SsisSql.Lint(statement, list: false).Select(problem => "ssis " + counts + ": " + problem));
            }
        problems.AddRange(LiveSql.Lint(LiveSql.UncommittedPrologue + LiveSql.SsisSession).Select(problem => "session: " + problem));
        problems.AddRange(LiveSql.Lint(LiveSql.UncommittedPrologue + LiveSql.CatalogState).Select(problem => "state: " + problem));
        check(problems.Count == 0, "the Operations sample, the SSISDB session probe and the catalog state read pass the live lint and the SSIS lint (no metadata built-ins, no datetime casts, no writes): "
            + string.Join("; ", problems));
        var withCounts = LiveSql.Operations(true);
        check(withCounts.Split("SELECT ").Length > 4 && !LiveSql.Operations(false).Contains("created_time >= DATEADD(hour, -24", StringComparison.Ordinal)
            && withCounts.Contains("created_time >= DATEADD(hour, -24", StringComparison.Ordinal) && withCounts.Contains("o.status IN (1, 2, 5, 8)", StringComparison.Ordinal)
            && withCounts.Contains("NOT IN (200, 300, 301, 101)", StringComparison.Ordinal),
            "only the counting sample reads the last 24 hours; every sample keeps open operations whatever their age, and Other is every type the other kinds leave out");
        // The lint still refuses what a careless edit would add: a session read outside the session probes, a datetime cast.
        check(LiveSql.Lint(LiveSql.UncommittedPrologue + "SELECT @@SPID;").Count > 0 && SsisSql.Lint("SELECT CONVERT(datetime, o.created_time) FROM [catalog].[operations] AS o;", false).Count > 0,
            "the lints still refuse a stray @@SPID and a datetime cast");
    }

    private static void Args(Action<bool, string> check)
    {
        var catalog = SsisCatalog.Current;
        SsisOperationsLiveArgs Parse(string text) => SsisOperationsArgs.Check(JsonSerializer.Deserialize<SsisOperationsLiveArgs>(text, Json)!, catalog);
        bool Refused(string text)
        {
            try { Parse(text); return false; }
            catch (RequestException error) { return error.Code == "INVALID_PARAMS"; }
            catch (JsonException) { return true; }
        }
        var full = Parse("{\"kinds\":[\"execution\",\"other\"],\"statuses\":[2,4],\"folder\":\"Fin_100%\",\"prefix\":true,\"caller\":\"CORP\\\\etl\",\"windowHours\":8760,\"limit\":10000}");
        check(full.Kinds!.Length == 2 && full.WindowHours == 8760 && Parse("{}") == new SsisOperationsLiveArgs(), "ssis.operations takes every filter at its bounds, and none");
        var refused = new[]
        {
            "{\"kinds\":[]}", "{\"kinds\":[\"execution\",\"execution\"]}", "{\"kinds\":[\"jobs\"]}", "{\"statuses\":[42]}", "{\"statuses\":[2,2]}", "{\"folder\":\"\"}",
            "{\"folder\":\"" + new string('f', 129) + "\"}", "{\"package\":\"" + new string('p', 261) + "\"}", "{\"caller\":\"" + new string('c', 129) + "\"}", "{\"windowHours\":0}",
            "{\"windowHours\":8761}", "{\"limit\":0}", "{\"limit\":10001}", "{\"since\":\"2026-10-01\"}"
        }.Where(text => !Refused(text)).ToList();
        check(refused.Count == 0 && !Refused("{\"package\":\"" + new string('p', 260) + "\"}"), "ssis.operations refuses what main's schema refuses: empty or repeated kinds and statuses, unknown ones, names past their bounds, a window or limit out of range, unknown members ("
            + string.Join(" ", refused) + ")");
        var filter = SsisOperationsFilter.Of(full, catalog);
        check(filter.Types is [200] && filter.Other && filter.Statuses is [2, 4] && filter.Folder == "Fin\\_100\\%%" && filter.Project is null && filter.Caller == "CORP\\etl" && filter.Limit == 10_000
            && SsisOperationsFilter.Of(null, catalog) is { Types: null, Other: false, Statuses: null, WindowHours: 24, Limit: 1000 }
            && SsisOperationsFilter.Of(new SsisOperationsLiveArgs(Kinds: ["other"]), catalog) is { Types: [], Other: true }
            && SsisOperationsFilter.Of(new SsisOperationsLiveArgs(Folder: "a[b]\\c"), catalog).Folder == "a\\[b]\\\\c",
            "the filters bind as the SQL reads them: the kinds' types and Other, a name's LIKE wildcards escaped (a prefix ends in %), and the catalogue's 24 hours and 1,000 rows by default");
    }

    private static SsisOperation Operation(long id, int status, DateTimeOffset? created = null, int type = 200, string folder = "Finance") =>
        new(id, type, status, created ?? Now.AddMinutes(-30), Now.AddMinutes(-29), status is 2 or 5 or 8 or 1 ? null : Now.AddMinutes(-20), "Loads", folder, "Loads", "Daily.dtsx",
            "CORP\\etl", status == 8 ? "CORP\\dba" : null, "SQL01", "SQL01", 9 * 60_000);

    private static void Window(Action<bool, string> check)
    {
        var catalog = SsisCatalog.Current;
        static long[] Ids(SsisOperationsWindow window) => [.. window.Rows().Select(row => (long)row.Cells[0].Value!)];
        var window = new SsisOperationsWindow(catalog);
        // A baseline: two old rows and one created a second ago, whose lower ids may still be committing.
        window.Baseline([Operation(3, 2, Now.AddSeconds(-1)), Operation(2, 7), Operation(1, 4)], Now, 0);
        check(!window.NeedsBaseline && Ids(window) is [3, 2, 1] && window.SettledId == 2,
            "a baseline shows the window newest first and settles every id but the one created within the settle window");
        // The next sample: id 3 read again (still unsettled) now Succeeded, a new id 5, and id 4 (lower, committed later) too.
        window.Merge([Operation(5, 2, Now), Operation(3, 7, Now.AddSeconds(-1))], [3], [new(3, 7, Now.AddMinutes(-29), Now, null, 1000)], Now, 1000);
        window.Merge([Operation(5, 2, Now), Operation(4, 5, Now)], [5], [new(5, 2, Now, null, null, 10)], Now.AddSeconds(1), 2000);
        check(Ids(window) is [5, 4, 3, 2, 1] && window.SettledId == 2, "an id committed after a higher one still arrives, since the window reads every id above the settled one again");
        window.Merge([], [5, 4], [new(5, 2, Now, null, null, 10), new(4, 5, null, null, null, null)], Now.AddSeconds(10), 12_000);
        check(window.SettledId == 5 && window.CountOf([2]) == 1 && window.CountOf([5]) == 1, "ids settle two samples and 5 s after they were first seen; Running and Pending count what the window holds");
        // The open ids read again: one ended (Stopping), one a refresh no longer finds (a dirty read rolled back, or cleaned up).
        window.Merge([], [5, 4], [new(5, 8, Now, null, "CORP\\dba", 20)], Now.AddSeconds(12), 14_000);
        var stopping = window.Rows().First();
        check(Ids(window) is [5, 3, 2, 1] && stopping.Cells[2].Text == "Stopping" && stopping.Cells[11].Text == "CORP\\dba" && stopping.Cells[^1].Text == "warning",
            "an open row read again takes its new status, stopper and tone, and one a refresh no longer finds leaves the window");

        // The status filter: Failed only. A running operation is followed unseen, and shows once it fails.
        var failed = new SsisOperationsWindow(catalog);
        failed.Use(SsisOperationsFilter.Of(new SsisOperationsLiveArgs(Statuses: [4]), catalog));
        failed.Baseline([Operation(12, 2), Operation(11, 4), Operation(10, 7)], Now, 0);
        check(Ids(failed) is [11] && failed.Ids.Order().SequenceEqual([11L, 12L]) && failed.CountOf([2]) == 1,
            "a status filter shows only its statuses, follows the open operations it hides (which Running still counts), and drops an ended one it hides");
        failed.Merge([], failed.OpenIds(256), [new(12, 4, Now.AddMinutes(-29), Now, null, 60_000)], Now, 1000);
        check(Ids(failed) is [12, 11] && failed.Rows()[0].Cells[^1].Text == "error", "a followed operation that ends in a shown status appears, toned");
        // What a window follows unseen is bounded by its limit too, newest first, so a sample never reads more than twice the limit.
        var bounded = new SsisOperationsWindow(catalog);
        bounded.Use(SsisOperationsFilter.Of(new SsisOperationsLiveArgs(Statuses: [4], Limit: 2), catalog));
        bounded.Baseline([.. Enumerable.Range(40, 5).Select(id => Operation(id, 2))], Now, 0);
        check(Ids(bounded).Length == 0 && bounded.Ids.Order().SequenceEqual([43L, 44L]) && bounded.Take == 4,
            "a window follows at most its limit of open operations the status filter hides, the newest: " + string.Join(",", bounded.Ids));

        // The window keeps open operations whatever their age, drops ended ones older than its hours, and keeps the newest past the limit.
        var aged = new SsisOperationsWindow(catalog);
        aged.Use(SsisOperationsFilter.Of(new SsisOperationsLiveArgs(WindowHours: 1, Limit: 2), catalog));
        aged.Baseline([Operation(24, 7), Operation(23, 7), Operation(22, 7), Operation(21, 2, Now.AddDays(-3)), Operation(20, 7, Now.AddHours(-2))], Now, 0);
        check(Ids(aged) is [24, 23] && aged.Ids.Order().SequenceEqual([21L, 23L, 24L]) && aged.CountOf([2]) == 1,
            "the limit shows the newest operations, and an open one past it is followed unseen, so Running still counts it: " + string.Join(",", Ids(aged)));
        var open = new SsisOperationsWindow(catalog);
        open.Use(SsisOperationsFilter.Of(new SsisOperationsLiveArgs(WindowHours: 1), catalog));
        open.Baseline([Operation(31, 7), Operation(30, 2, Now.AddDays(-3)), Operation(29, 7, Now.AddHours(-2))], Now, 0);
        check(Ids(open) is [31, 30], "a running operation created days ago stays in a one-hour window, and an ended one older than the window leaves (Active Operations finds a long run)");
        open.Merge([], [30], [new(30, 7, Now.AddDays(-3), Now, null, 3 * 86_400_000L)], Now, 1000);
        check(Ids(open) is [31], "once it ends, an operation older than the window leaves it");

        // More open operations than one sample reads again: they take turns, newest first, and every one is read within a few samples.
        var many = new SsisOperationsWindow(catalog);
        many.Baseline([.. Enumerable.Range(1, 600).Select(id => Operation(id, 2))], Now, 0);
        var turns = new List<long[]> { many.OpenIds(256), many.OpenIds(256), many.OpenIds(256) };
        check(turns.All(turn => turn.Length == 256) && turns[0][0] == 600 && turns.SelectMany(turn => turn).Distinct().Count() == 600,
            "more than 256 open operations are read again in turns of 256, newest first, all of them within three samples");
    }

    private static void Rows(Action<bool, string> check)
    {
        var window = new SsisOperationsWindow(SsisCatalog.Current);
        window.Baseline([Operation(7, 4, type: 101, folder: "Data | Ops"), new SsisOperation(6, 42, 99, Now.AddMinutes(-5), null, null, null, null, null, null, "sa", null, null, null, null)], Now, 0);
        var rows = window.Rows();
        var first = rows[0].Cells.Select(cell => cell.Text).ToList();
        check(rows.Count == 2 && first[0] == "7" && first[1] == "Deploy project" && first[2] == "Failed" && first[3] == "Data | Ops" && first[7] == "2026-10-26 11:31:00.0000000 -05:00"
            && first[9] == "0:09:00.000" && (long)rows[0].Cells[9].Value! == 540_000 && first[^1] == "error",
            "a row's cells are labels for codes, times with their offset as a query shows them, the duration as h:mm:ss.fff sorted by its milliseconds, and its tone");
        var odd = rows[1].Cells.Select(cell => cell.Text).ToList();
        check(odd[1] == "Unknown (42)" && odd[2] == "Unknown (99)" && odd[7] is null && odd[9] is null && odd[^1] is null && SsisOperationsWindow.Duration(26 * 3_600_000L + 61_001) == "26:01:01.001",
            "an unknown type or status says so with its code, a row that never started has no start or duration, and durations past a day keep counting hours");
    }
}
