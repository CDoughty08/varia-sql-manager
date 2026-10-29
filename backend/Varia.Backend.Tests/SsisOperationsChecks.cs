using System.Text.Json;
using Varia.Backend.Explorer;
using Varia.Backend.Live;
using Varia.Backend.Ssis;

namespace Varia.Backend.Tests;

/// <summary>Offline checks of PR S3, the ssis.operations live source: its catalogue entry against the SSIS catalogue's tiles and
/// tones, its SQL against the live and SSIS lints (the counts outside the filters' scope), its args against main's schema
/// through tests/fixtures/live/ssis-operations-args.json, the filters it binds, the window's state machine (baseline, settle
/// from the catalogue, open refreshes in turn, rows a refresh no longer finds, the status filter's followed rows, open
/// operations of any age and first within the limit), the rows it writes, and why it cannot open the catalog (missing,
/// unavailable, closed to the login; Linux and versions before 2016), all without SQL Server.</summary>
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
        Failures(check);
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
        check(table is { Mode: "snapshot", Key: ["operationId"], Departed: true, Settle: { Ticks: >= 1, Ms: >= 0 } } && table.Columns.Count == 15 && table.Columns[^1] is { Id: "tone", Role: "tone" }
            && SsisOperationsWindow.CatalogueSettle == table.Settle
            && ssis.OperationTones.Values.All(tone => tone is "error" or "warning" or "muted") && ssis.OperationTones[4] == "error" && ssis.OperationTones[8] == "warning"
            && !ssis.OperationTones.ContainsKey(2) && !ssis.OperationTones.ContainsKey(5) && !ssis.OperationTones.ContainsKey(7),
            "the operations table is keyed by id, keeps a departed selection, names the settle window the window uses, ends in its tone column, and its tones are live grid tones "
            + "(failed error, stopping warning; running, pending and succeeded none, since the running tone is the selection's hue)");
        check(ssis.OperationKinds.Keys.SequenceEqual(["execution", "validation", "deploy", "other"]) && ssis.OperationKinds["other"].Count == 0
            && ssis.OperationKinds["execution"].SequenceEqual([200]) && ssis.OperationKinds["validation"].SequenceEqual([300, 301]),
            "the kinds name their operation types, and other names none (it is every type the rest leave out)");
    }

    private static void Lint(Action<bool, string> check)
    {
        var problems = new List<string>();
        foreach (var counts in new[] { false, true })
            foreach (var baseline in new[] { false, true })
                foreach (var prologue in new[] { LiveSql.UncommittedPrologue, LiveSql.CommittedPrologue })
                {
                    var text = prologue + LiveSql.Operations(counts, baseline);
                    problems.AddRange(LiveSql.Lint(text).Select(problem => "live " + counts + baseline + ": " + problem));
                    foreach (var statement in LiveSql.Operations(counts, baseline).Split(";\n", StringSplitOptions.RemoveEmptyEntries))
                        problems.AddRange(SsisSql.Lint(statement, list: false).Select(problem => "ssis " + counts + baseline + ": " + problem));
                }
        problems.AddRange(LiveSql.Lint(LiveSql.UncommittedPrologue + LiveSql.SsisSession).Select(problem => "session: " + problem));
        problems.AddRange(LiveSql.Lint(LiveSql.UncommittedPrologue + LiveSql.CatalogState).Select(problem => "state: " + problem));
        check(problems.Count == 0, "the Operations sample, the SSISDB session probe and the catalog state read pass the live lint and the SSIS lint (no metadata built-ins, no datetime casts, no writes): "
            + string.Join("; ", problems));
        var full = LiveSql.Operations(true, true).Split(";\n");
        var steady = LiveSql.Operations(false, false).Split(";\n");
        check(full.Length == 6 && steady.Length == 4 && full[0].Contains("o.status IN (1, 2, 5, 8)", StringComparison.Ordinal) && full[0].Contains("NOT IN (200, 300, 301, 101)", StringComparison.Ordinal)
            && full[1].Contains("WHERE o.status IN (1, 2, 5, 8)\n", StringComparison.Ordinal) && !full[1].Contains("DATEADD", StringComparison.Ordinal) && full[1].Contains("@folder", StringComparison.Ordinal)
            && !LiveSql.Operations(false, false).Contains("created_time >= DATEADD(hour, -24", StringComparison.Ordinal) && full[^1].Contains("created_time >= DATEADD(hour, -24", StringComparison.Ordinal),
            "a new window also reads the open operations of its scope whatever their age, and only the counting sample reads the last 24 hours; Other is every type the other kinds leave out");
        // The tiles count every operation the login may see: neither count names the scope's parameters or joins.
        var tileCounts = new[] { full[^2], full[^1], steady[^1] };
        check(tileCounts.All(text => text.StartsWith("SELECT COUNT_BIG(", StringComparison.Ordinal) && !text.Contains('@') && !text.Contains("JOIN", StringComparison.Ordinal))
            && steady[^1].Contains("AS running, COUNT_BIG(CASE WHEN o.status IN (5) THEN 1 END) AS pending", StringComparison.Ordinal) && steady[^1].EndsWith("WHERE o.status IN (2, 5);", StringComparison.Ordinal),
            "every sample counts Running and Pending, and every 30 s the last 24 hours, over every operation whatever the filters: " + string.Join(" | ", tileCounts));
        check(full[0].Contains("COALESCE(e.folder_name, v.folder_name)", StringComparison.Ordinal) && full[0].Contains("CASE WHEN o.operation_type = 101 THEN o.object_name END", StringComparison.Ordinal)
            && full[0].Contains("n.project_name LIKE @project", StringComparison.Ordinal) && full[0].Contains("e.package_name LIKE @package", StringComparison.Ordinal),
            "Folder and Project match a validation's names as an execution's, and Project a deployment's project; Package is an execution's");
        // The lint still refuses what a careless edit would add: a session read outside the session probes, a datetime cast.
        check(LiveSql.Lint(LiveSql.UncommittedPrologue + "SELECT @@SPID;").Count > 0 && SsisSql.Lint("SELECT CONVERT(datetime, o.created_time) FROM [catalog].[operations] AS o;", false).Count > 0,
            "the lints still refuse a stray @@SPID and a datetime cast");
    }

    /// <summary>The args main's schema accepts and refuses (tests/ssis-operations.test.ts runs the same fixture through zod).</summary>
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
        using var fixture = JsonDocument.Parse(File.ReadAllText(Path.Combine(GoldenText.Repository(), "tests", "fixtures", "live", "ssis-operations-args.json")));
        var accepted = fixture.RootElement.GetProperty("accepted").EnumerateArray().Select(item => item.GetRawText()).ToList();
        var refusedCases = fixture.RootElement.GetProperty("refused").EnumerateArray().Select(item => item.GetRawText()).ToList();
        var wrongly = accepted.Where(Refused).Concat(refusedCases.Where(text => !Refused(text))).ToList();
        check(accepted.Count >= 3 && refusedCases.Count >= 20 && wrongly.Count == 0,
            "ssis.operations accepts and refuses what main's schema does (tests/fixtures/live/ssis-operations-args.json): empty or repeated kinds and statuses, unknown ones, names past their bounds, "
            + "a window or limit out of range or not whole, unknown members (" + string.Join(" ", wrongly.Select(text => text.Length > 60 ? text[..60] + "…" : text)) + ")");
        var full = Parse(accepted[1]);
        check(full.Kinds!.Length == 2 && full.WindowHours == 8760 && Parse("{}") == new SsisOperationsLiveArgs(), "ssis.operations takes every filter at its bounds, and none");
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

    private static SsisOperationsWindow New() => new(SsisCatalog.Current, SsisOperationsWindow.CatalogueSettle);

    private static void Window(Action<bool, string> check)
    {
        var catalog = SsisCatalog.Current;
        var settle = SsisOperationsWindow.CatalogueSettle;
        static long[] Ids(SsisOperationsWindow window) => [.. window.Rows().Select(row => (long)row.Cells[0].Value!)];
        var window = New();
        // A baseline: two old rows and one created a second ago, whose lower ids may still be committing.
        window.Baseline([Operation(3, 2, Now.AddSeconds(-1)), Operation(2, 7), Operation(1, 4)], Now, 0);
        check(!window.NeedsBaseline && Ids(window) is [3, 2, 1] && window.SettledId == 2,
            "a baseline shows the window newest first and settles every id but the one created within the settle window");
        // The next sample: id 3 read again (still unsettled) now Succeeded, a new id 5, and id 4 (lower, committed later) too.
        window.Merge([Operation(5, 2, Now), Operation(3, 7, Now.AddSeconds(-1))], [3], [new(3, 7, Now.AddMinutes(-29), Now, null, 1000)], Now, 1000);
        window.Merge([Operation(5, 2, Now), Operation(4, 5, Now)], [5], [new(5, 2, Now, null, null, 10)], Now.AddSeconds(1), 2000);
        check(Ids(window) is [5, 4, 3, 2, 1] && window.SettledId == 2, "an id committed after a higher one still arrives, since the window reads every id above the settled one again");
        // A millisecond short of the catalogue's settle window after 5 was first seen, only the baseline's 3 settles; past it, 4 and 5 do.
        window.Merge([], [5, 4], [new(5, 2, Now, null, null, 10), new(4, 5, null, null, null, null)], Now.AddSeconds(10), 1000 + settle.Ms - 1);
        var early = window.SettledId;
        for (var tick = 0; tick < settle.Ticks; tick++) window.Merge([], [5, 4], [new(5, 2, Now, null, null, 10), new(4, 5, null, null, null, null)], Now.AddSeconds(10), 3000 + settle.Ms);
        check(early == 3 && window.SettledId == 5, "ids settle after the catalogue's settle window (" + settle.Ticks + " samples and " + settle.Ms + " ms) and not before: " + early + " " + window.SettledId);
        // The open ids read again: one ended (Stopping), one a refresh no longer finds (a dirty read rolled back, or cleaned up).
        window.Merge([], [5, 4], [new(5, 8, Now, null, "CORP\\dba", 20)], Now.AddSeconds(12), 14_000);
        var stopping = window.Rows().First();
        check(Ids(window) is [5, 3, 2, 1] && stopping.Cells[2].Text == "Stopping" && stopping.Cells[11].Text == "CORP\\dba" && stopping.Cells[^1].Text == "warning",
            "an open row read again takes its new status, stopper and tone, and one a refresh no longer finds leaves the window");

        // The status filter: Failed only. A running operation is followed unseen, and shows once it fails.
        var failed = New();
        failed.Use(SsisOperationsFilter.Of(new SsisOperationsLiveArgs(Statuses: [4]), catalog));
        failed.Baseline([Operation(12, 2), Operation(11, 4), Operation(10, 7)], Now, 0);
        check(Ids(failed) is [11] && failed.Ids.Order().SequenceEqual([11L, 12L]),
            "a status filter shows only its statuses, follows the open operations it hides, and drops an ended one it hides");
        failed.Merge([], failed.OpenIds(256), [new(12, 4, Now.AddMinutes(-29), Now, null, 60_000)], Now, 1000);
        check(Ids(failed) is [12, 11] && failed.Rows()[0].Cells[^1].Text == "error", "a followed operation that ends in a shown status appears, toned");
        // What a window follows unseen is bounded by its limit too, newest first, so a sample never reads more than twice the limit.
        var bounded = New();
        bounded.Use(SsisOperationsFilter.Of(new SsisOperationsLiveArgs(Statuses: [4], Limit: 2), catalog));
        bounded.Baseline([.. Enumerable.Range(40, 5).Select(id => Operation(id, 2))], Now, 0);
        check(Ids(bounded).Length == 0 && bounded.Ids.Order().SequenceEqual([43L, 44L]) && bounded.Take == 4,
            "a window follows at most its limit of open operations the status filter hides, the newest: " + string.Join(",", bounded.Ids));

        // Open operations come first within the limit, whatever their age, and ended ones older than the window's hours leave.
        var aged = New();
        aged.Use(SsisOperationsFilter.Of(new SsisOperationsLiveArgs(WindowHours: 1, Limit: 2), catalog));
        aged.Baseline([Operation(24, 7), Operation(23, 7), Operation(22, 7), Operation(21, 2, Now.AddDays(-3)), Operation(20, 7, Now.AddHours(-2))], Now, 0);
        check(Ids(aged) is [24, 21] && aged.Ids.Order().SequenceEqual([21L, 24L]),
            "within the limit an open operation days old comes first, then the newest ended ones (Stop Operation can always reach a long run): " + string.Join(",", Ids(aged)));
        // A busy catalog: 250 finished operations newer than a long run, with the least limit; the baseline read it apart.
        var busy = New();
        busy.Use(SsisOperationsFilter.Of(new SsisOperationsLiveArgs(Limit: 100), catalog));
        busy.Baseline([.. Enumerable.Range(1001, 250).Reverse().Select(id => Operation(id, 7, Now.AddSeconds(id - 1300))), Operation(1000, 2, Now.AddHours(-20))], Now, 0);
        check(Ids(busy).Length == 100 && Ids(busy).Contains(1000) && Ids(busy)[0] == 1250, "a running operation behind more than twice the limit of newer finished ones is still shown");
        var open = New();
        open.Use(SsisOperationsFilter.Of(new SsisOperationsLiveArgs(WindowHours: 1), catalog));
        open.Baseline([Operation(31, 7), Operation(30, 2, Now.AddDays(-3)), Operation(29, 7, Now.AddHours(-2))], Now, 0);
        check(Ids(open) is [31, 30], "a running operation created days ago stays in a one-hour window, and an ended one older than the window leaves (Active Operations finds a long run)");
        open.Merge([], [30], [new(30, 7, Now.AddDays(-3), Now, null, 3 * 86_400_000L)], Now, 1000);
        check(Ids(open) is [31], "once it ends, an operation older than the window leaves it");

        // More open operations than one sample reads again: they take turns, newest first, and every one is read within a few samples.
        var many = New();
        many.Baseline([.. Enumerable.Range(1, 600).Select(id => Operation(id, 2))], Now, 0);
        var turns = new List<long[]> { many.OpenIds(256), many.OpenIds(256), many.OpenIds(256) };
        check(turns.All(turn => turn.Length == 256) && turns[0][0] == 600 && turns.SelectMany(turn => turn).Distinct().Count() == 600,
            "more than 256 open operations are read again in turns of 256, newest first, all of them within three samples");
    }

    private static void Rows(Action<bool, string> check)
    {
        var window = New();
        window.Baseline([Operation(7, 4, type: 101, folder: "Data | Ops"), new SsisOperation(6, 42, 99, Now.AddMinutes(-5), null, null, null, null, null, null, "sa", null, null, null, null)], Now, 0);
        var rows = window.Rows();
        var first = rows[0].Cells.Select(cell => cell.Text).ToList();
        check(rows.Count == 2 && first[0] == "7" && first[1] == "Deploy project" && first[2] == "Failed" && first[3] == "Data | Ops" && first[7] == "2026-10-26 11:31:00 -05:00"
            && rows[0].Cells[7].Value is DateTimeOffset start && start == Now.AddMinutes(-29) && first[9] == "0:09:00.000" && (long)rows[0].Cells[9].Value! == 540_000 && first[^1] == "error",
            "a row's cells are labels for codes, times to the second with their offset (sorting by their full value), the duration as h:mm:ss.fff sorted by its milliseconds, and its tone: "
            + string.Join(",", first));
        var odd = rows[1].Cells.Select(cell => cell.Text).ToList();
        check(odd[1] == "Unknown (42)" && odd[2] == "Unknown (99)" && odd[7] is null && odd[9] is null && odd[^1] is null && SsisOperationsWindow.Duration(26 * 3_600_000L + 61_001) == "26:01:01.001",
            "an unknown type or status says so with its code, a row that never started has no start or duration, and durations past a day keep counting hours");
    }

    /// <summary>Why a subscription cannot open the catalog's database, and where the source does not run at all.</summary>
    private static void Failures(Action<bool, string> check)
    {
        const string Probe = LiveSql.OperationsProbe;
        static string Of(LiveProbeError error) => error.Code + (error.Terminal ? " terminal" : " retried");
        var cases = new (int? State, int? Access, bool SeesAll, string Expected)[]
        {
            (null, null, true, "CATALOG_MISSING terminal"),
            // A login that does not see every database's row sees none of one it cannot open: that says nothing about the catalog.
            (null, null, false, "PERMISSION_DENIED terminal"),
            (1, 0, true, "DATABASE_UNAVAILABLE retried"), (6, 0, false, "DATABASE_UNAVAILABLE retried"),
            (0, 1, true, "DATABASE_UNAVAILABLE retried"), (0, 2, true, "DATABASE_UNAVAILABLE retried"),
            (0, 0, true, "PERMISSION_DENIED terminal"), (0, 0, false, "PERMISSION_DENIED terminal")
        };
        var wrong = cases.Select(item => (Case: item, Got: Of(LiveErrors.Catalog(Probe, item.State, item.Access, item.SeesAll)))).Where(pair => pair.Got != pair.Case.Expected).ToList();
        check(wrong.Count == 0 && LiveErrors.Catalog(Probe, null, null, true).Message == LiveErrors.CatalogMissingMessage && LiveErrors.Catalog(Probe, null, null, false).Message == LiveErrors.CatalogAccessMessage
            && LiveErrors.Catalog(Probe, 0, 0, true).Message == LiveErrors.CatalogAccessMessage,
            "the catalog's sys.databases row says why it cannot be opened: missing only when the login sees every row, unavailable (retried) while offline, recovering, single-user or restricted, "
            + "otherwise no access: " + string.Join("; ", wrong.Select(pair => pair.Case + " → " + pair.Got)));

        static Microsoft.Data.SqlClient.SqlException Errors(params int[] numbers) => ConnectionFailureChecks.SqlMany([.. numbers.Select(number => (number, (byte)(number == 4060 ? 11 : 14)))]);
        check(LiveErrors.OpensNoDatabase(Errors(4060)) && LiveErrors.OpensNoDatabase(Errors(916)) && LiveErrors.OpensNoDatabase(Errors(4060, 18456))
            && !LiveErrors.OpensNoDatabase(Errors(4060, 942)) && !LiveErrors.OpensNoDatabase(Errors(942)) && !LiveErrors.OpensNoDatabase(Errors(18456)),
            "a connection that cannot open the catalog's database (4060, 916) asks its row why, unless the error already says the database is unavailable (942 offline): it stays DATABASE_UNAVAILABLE");

        var catalog = SsisCatalog.Current;
        var spec = LiveCatalog.Current.Probes[Probe];
        (string Reason, string Note)? Unavailable(ServerProfile profile, bool ignoreLinux = false) => new SsisOperationsReader(catalog, null, () => "SSISDB", ignoreLinux).Unavailable(spec, profile);
        var linux = new ServerProfile(16, "16.0.4135.4", 3, "sa", false, true, false, Linux: true);
        var windows = linux with { Linux = false };
        check(Unavailable(linux) is ("NOT_SUPPORTED", var note) && note.Contains("Linux", StringComparison.Ordinal) && Unavailable(linux, ignoreLinux: true) is null && Unavailable(windows) is null
            && Unavailable(windows with { Major = 12 }) is ("NOT_SUPPORTED", var old) && old.Contains("2016", StringComparison.Ordinal) && Unavailable(windows with { Major = 13 }) is null
            && Unavailable(windows with { Major = 12, EngineEdition = 5 }) is null && Unavailable(windows with { Major = 12, EngineEdition = 8 }) is null,
            "Operations is not supported on SQL Server on Linux (unless the checks' fake catalog says otherwise) nor before SQL Server 2016; Azure SQL Database and Managed Instance report their own versions");
    }
}
