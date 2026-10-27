using System.Text.Json;
using Varia.Backend.Explorer;
using Varia.Backend.Live;
using Varia.Backend.Protocol;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>Offline checks of the live scheduler and the SQL sources' parts that need no server: the catalogue's scheduler
/// fields, LiveSql's text and lint, the delta engine, the schedule on a fake clock (phases, fixed rate, quick second sample,
/// back-off, load guard, refresh gaps, terminal probes), the live gates, resume tokens, error mapping, and the loop over a
/// scripted sampler (stop-and-wait, no overlap, idle, failed ends, resume, spid).</summary>
internal static class LiveSchedulerChecks
{
    private const int Credit = 64 * 1024;

    public static async Task RunAsync(Action<bool, string> check)
    {
        CatalogChecks(check);
        SqlChecks(check);
        DeltaChecks(check);
        ScheduleChecks(check);
        await GateChecks(check);
        ResumeChecks(check);
        ErrorChecks(check);
        await LoopChecks(check);
        await SamplerChecks(check);
        await ServiceChecks(check);
    }

    private static void CatalogChecks(Action<bool, string> check)
    {
        var catalog = LiveCatalog.Current;
        check(catalog.Limits is { StatementsPerConnection: 2, Statements: 8, BudgetMs: { Min: 500, Max: 10_000 }, BackoffMs: 60_000, IdleMs: 30_000 },
            "the live limits carry the scheduler's gates (2 per connection, 8 in all), budget range, back-off cap and idle threshold");
        check(catalog.Sources.TryGetValue("activity", out var activity) && activity is { Scope: "server", TestOnly: false } && activity.Probes.SequenceEqual([LiveSql.OverviewProbe])
            && catalog.Probes[LiveSql.OverviewProbe] is { IntervalMs: { Default: 2000, Min: 1000 }, MaxDutyCycle: 0.2, Permission: "serverState", Gates: { MinMajor: 13 } } overview
            && overview.Gates.Editions.SequenceEqual([1, 2, 3, 4, 8]) && overview.Budget is { Min: 500, Max: 5000 }
            && overview.Series.Select(series => series.Id + ":" + series.Counter).SequenceEqual(["cpuPercent:cpuPercent", "runnableTasks:gauge", "batchRequests:rate", "compilations:rate", "recompilations:rate", "userSessions:gauge"]),
            "the embedded catalogue ships the Activity Monitor source with its overview probe: 2 s by default, a 0.2 load guard, server state, 2016 and later on box and Managed Instance");
        check(catalog.Sources.TryGetValue("ssis.catalog", out var ssis) && ssis is { Scope: "ssisdb", TestOnly: false } && ssis.Probes.SequenceEqual([LiveSql.CatalogProbe])
            && catalog.Probes[LiveSql.CatalogProbe] is { IntervalMs: { Default: 30_000, Min: 10_000, Max: 300_000 }, Permission: "none", Gates: null, Series.Count: 0, Tables.Count: 0 } probe
            && probe.Budget is { Min: 500, Max: 10_000 } && probe.Status.SequenceEqual(LiveSql.FingerprintIds.SelectMany(id => new[] { id + "Count", id + "Checksum" })),
            "the embedded catalogue ships the SSIS Catalog source (scope ssisdb) with its tree probe: every 30 s (10 s to 300 s), a 10 s budget, and a count and checksum per fingerprinted view, in LiveSql's order");
    }

    private static void SqlChecks(Action<bool, string> check)
    {
        var catalog = LiveCatalog.Current;
        var queries = LiveSql.All(catalog).ToList();
        var problems = queries.SelectMany(query => LiveSql.Lint(query.Text(LiveSql.UncommittedPrologue)).Select(problem => query.Probe + " band " + query.Band + ": " + problem))
            .Concat(LiveSql.Lint(LiveSql.UncommittedPrologue + LiveSql.Session).Select(problem => "session: " + problem))
            .Concat(LiveSql.Lint(LiveSql.UncommittedPrologue + LiveSql.CatalogState).Select(problem => "catalog state: " + problem))
            .Concat(queries.Where(query => query.Probe == LiveSql.CatalogProbe).SelectMany(query => LiveSql.Lint(query.Text(LiveSql.CommittedPrologue))).Select(problem => "catalog probe, read committed: " + problem))
            .Concat(queries.Where(query => query.Restricted is not null).SelectMany(query => LiveSql.Lint(query.Text(LiveSql.UncommittedPrologue, admin: false))
                .Concat(LiveSql.Lint(query.Text(LiveSql.CommittedPrologue, admin: false))).Select(problem => query.Probe + " band " + query.Band + ", restricted: " + problem))).ToList();
        check(queries.Count == 2 * (LiveSql.MaxBand - LiveSql.MinBand + 1) && problems.Count == 0,
            "every SQL probe's text passes the live lint at every band, with the session probe and the catalog state read (" + queries.Count + "): " + string.Join("; ", problems.Take(5)));
        // Every series of a SQL probe comes from a column its query returns, and the clock columns are among them.
        var unmapped = queries.SelectMany(query => catalog.Probes[query.Probe].Series.Where(series => query.Series.FirstOrDefault(entry => entry.Series == series.Id) is not { } mapping
            || !query.Columns.Contains(mapping.Column) || mapping.Base is { } baseColumn && !query.Columns.Contains(baseColumn)
            || series.Counter is "ratio" or "cpuPercent" && mapping.Base is null).Select(series => query.Probe + "." + series.Id)).ToList();
        check(unmapped.Count == 0 && queries.All(query => query.Columns.Distinct(StringComparer.Ordinal).Count() == query.Columns.Length
                && (query.MsTicks is null || query.Columns.Contains(query.MsTicks)) && (query.StartTicks is null || query.Columns.Contains(query.StartTicks)))
            && LiveSql.For(LiveSql.OverviewProbe, 12) is null && LiveSql.For("debug.synthetic.metrics", 17) is null,
            "every series maps to a column of its probe's one row (ratios and CPU with a base), the clock columns are there, and no overview query exists below 2016: " + string.Join(", ", unmapped));
        // Every status value of a SQL probe comes from a column of its one row, in the catalogue's order; the SSIS Catalog's
        // views are the same on every version, so its probe also runs at Azure SQL Database's band (12).
        var unmappedStatus = queries.Where(query => !catalog.Probes[query.Probe].Status.SequenceEqual((query.Status ?? []).Select(entry => entry.Status))
            || (query.Status ?? []).Any(entry => !query.Columns.Contains(entry.Column))).Select(query => query.Probe + " band " + query.Band).ToList();
        var fingerprint = LiveSql.For(LiveSql.CatalogProbe, 12);
        check(unmappedStatus.Count == 0 && fingerprint is { MsTicks: null, StartTicks: null, Series.Length: 0, Status.Length: 16 } && LiveSql.For(LiveSql.CatalogProbe, 11) is null
            && fingerprint.Body == LiveSql.For(LiveSql.CatalogProbe, LiveSql.MaxBand)!.Body && fingerprint.Returns([.. fingerprint.Columns.Select(column => (column, typeof(long)))]),
            "every status value maps to a column of its probe's one row, in the catalogue's order, and the catalog probe runs at any band from 12, with one text: " + string.Join(", ", unmappedStatus));
        // The checksum sums a hash per row (equal rows never cancel, as CHECKSUM_AGG's XOR would), covers sql_variant values as
        // bytes, and reads only the catalog's own views, as row-level security shows them.
        check(fingerprint!.Body.Contains("HASHBYTES('SHA2_256', ", StringComparison.Ordinal) && !fingerprint.Body.Contains("CHECKSUM_AGG", StringComparison.OrdinalIgnoreCase) && !fingerprint.Body.Contains("BINARY_CHECKSUM", StringComparison.OrdinalIgnoreCase)
            && fingerprint.Body.Contains("ISNULL(CONVERT(varbinary(8000), x.value), 0x)", StringComparison.Ordinal) && fingerprint.Body.Contains("ISNULL(CONVERT(varbinary(8000), x.default_value), 0x)", StringComparison.Ordinal)
            && System.Text.RegularExpressions.Regex.Matches(fingerprint.Body, @"FROM (\S+) AS x").Select(match => match.Groups[1].Value).All(from => from.StartsWith("[catalog].[", StringComparison.Ordinal))
            && System.Text.RegularExpressions.Regex.Matches(fingerprint.Body, @"FROM (\S+) AS x").Count == 8,
            "the catalog probe sums a SHA-256 prefix per row of each of its 8 catalog views (no CHECKSUM_AGG), with sql_variant values as bytes");
        // catalog_properties is readable only by ssis_admin and sysadmin (the session probe reads which, a sysadmin's without
        // IS_MEMBER): everyone else's text leaves it out, as zeros, and is the admins' otherwise, with the same columns. Neither
        // takes a parameter, so the command is a plain batch and its prologue's SET options stay on the session.
        var restricted = fingerprint.Restricted ?? "";
        check(fingerprint.Body.Contains("FROM [catalog].[catalog_properties] AS x", StringComparison.Ordinal) && !restricted.Contains("catalog_properties", StringComparison.Ordinal)
            && restricted.Contains("CONVERT(bigint, 0) AS properties_count, CONVERT(bigint, 0) AS properties_checksum", StringComparison.Ordinal)
            && System.Text.RegularExpressions.Regex.Matches(restricted, @"FROM (\S+) AS x").Count == 7 && fingerprint.Text(LiveSql.UncommittedPrologue, admin: false) == LiveSql.UncommittedPrologue + restricted
            && fingerprint.Text(LiveSql.UncommittedPrologue) == LiveSql.UncommittedPrologue + fingerprint.Body && !fingerprint.Body.Contains('@') && !restricted.Contains('@')
            && LiveSql.For(LiveSql.OverviewProbe, LiveSql.MaxBand) is { Restricted: null } overview && overview.Text("", admin: false) == overview.Body
            && LiveSql.Session.Contains("WHEN @catalog IS NULL THEN 0 WHEN IS_SRVROLEMEMBER(N'sysadmin') = 1 THEN 1 ELSE CONVERT(int, ISNULL(IS_MEMBER(N'ssis_admin'), 0)) END", StringComparison.Ordinal),
            "the catalog probe reads catalog_properties only in an admin's text (sysadmin or ssis_admin, as the session probe reads), and as zeros otherwise, with no parameter: " + restricted[..Math.Min(400, restricted.Length)]);
        // The lint catches what it is for.
        var bad = new Dictionary<string, string>
        {
            ["no prologue"] = "SELECT 1;",
            ["metadata function"] = LiveSql.UncommittedPrologue + "SELECT OBJECT_NAME(object_id) FROM sys.objects;",
            ["database name function"] = LiveSql.UncommittedPrologue + "SELECT DB_NAME(database_id) FROM sys.dm_exec_sessions;",
            ["temporary table"] = LiveSql.UncommittedPrologue + "SELECT a FROM #t;",
            ["select into"] = LiveSql.UncommittedPrologue + "SELECT 1 AS a INTO dbo.t;",
            ["ddl"] = LiveSql.UncommittedPrologue + "DROP TABLE dbo.t;",
            ["write"] = LiveSql.UncommittedPrologue + "UPDATE dbo.t SET a = 1;",
            ["transaction"] = LiveSql.UncommittedPrologue + "BEGIN TRAN; SELECT 1;",
            ["wait"] = LiveSql.UncommittedPrologue + "WAITFOR DELAY '00:00:01';",
            ["dynamic sql"] = LiveSql.UncommittedPrologue + "EXEC sys.sp_executesql N'SELECT 1';",
            ["top without order"] = LiveSql.UncommittedPrologue + "SELECT TOP (@cap) session_id FROM sys.dm_exec_sessions;",
            ["top without parentheses"] = LiveSql.UncommittedPrologue + "SELECT TOP 5 s.session_id FROM sys.dm_exec_sessions AS s;",
            ["order by only in a window"] = LiveSql.UncommittedPrologue + "SELECT TOP (@cap) ROW_NUMBER() OVER (ORDER BY s.session_id) AS n FROM sys.dm_exec_sessions AS s;",
            ["order by only in another statement"] = LiveSql.UncommittedPrologue + "SELECT TOP (@cap) s.session_id FROM sys.dm_exec_sessions AS s;\nSELECT r.session_id FROM sys.dm_exec_requests AS r ORDER BY r.session_id;",
            ["order by only in a subquery"] = LiveSql.UncommittedPrologue + "SELECT TOP (@cap) x.session_id FROM (SELECT TOP (10) s.session_id FROM sys.dm_exec_sessions AS s ORDER BY s.session_id) AS x;",
            ["apostrophe in a comment hides a write"] = LiveSql.UncommittedPrologue + "SELECT 1 AS a -- don't\n; DELETE FROM dbo.t; SELECT 'x' AS b;",
            ["block comment"] = LiveSql.UncommittedPrologue + "SELECT 1 AS a /* the server's clock */;",
            ["unclosed block comment"] = LiveSql.UncommittedPrologue + "SELECT 1 AS a /* open;",
            ["built-in with a space"] = LiveSql.UncommittedPrologue + "SELECT OBJECT_NAME (p.object_id) FROM sys.dm_exec_procedure_stats AS p;",
            ["quote in a bracketed name hides a write"] = LiveSql.UncommittedPrologue + "SELECT 1 AS [it's]; DELETE FROM dbo.t; SELECT 'x' AS b;",
            ["openquery"] = LiveSql.UncommittedPrologue + "SELECT * FROM OPENQUERY(L, N'x');",
            ["openrowset"] = LiveSql.UncommittedPrologue + "SELECT * FROM OPENROWSET(N'SQLNCLI', N'x', N'SELECT 1');",
            ["opendatasource"] = LiveSql.UncommittedPrologue + "SELECT * FROM OPENDATASOURCE(N'SQLNCLI', N'x').m.sys.objects;",
            ["spid outside the session probe"] = LiveSql.UncommittedPrologue + "SELECT @@SPID;"
        };
        var missed = bad.Where(item => LiveSql.Lint(item.Value).Count == 0).Select(item => item.Key).ToList();
        var good = new[]
        {
            "SELECT TOP (@cap) s.session_id FROM sys.dm_exec_sessions AS s ORDER BY s.session_id;",
            "SELECT TOP 5 s.session_id, ROW_NUMBER() OVER (ORDER BY s.login_time) AS n FROM sys.dm_exec_sessions AS s ORDER BY s.session_id;",
            "SELECT x.session_id FROM (SELECT TOP (10) s.session_id FROM sys.dm_exec_sessions AS s ORDER BY s.session_id) AS x;",
            "SELECT p.cntr_value FROM sys.dm_os_performance_counters AS p WHERE p.counter_name = N'DROP INTO EXEC -- /*';",
            "SELECT 1 AS [order -- by];"
        }.Where(text => LiveSql.Lint(LiveSql.UncommittedPrologue + text).Count != 0).ToList();
        check(missed.Count == 0 && good.Count == 0,
            "the live lint refuses metadata functions (however spaced), temporary tables, writes, DDL, transactions, waits, dynamic SQL, remote reads, comments, a TOP without an ORDER BY at its own level and a missing prologue, and reads no code as a literal, comment or name it is not: "
            + string.Join(", ", missed) + " | " + string.Join(", ", good));
        // Values are read by declared position, so every read checks what it got against the declaration.
        var overviewQuery = LiveSql.For(LiveSql.OverviewProbe, LiveSql.MaxBand)!;
        var declared = overviewQuery.Columns.Select(column => (column, typeof(long))).ToList();
        var swapped = declared.ToList();
        (swapped[5], swapped[6]) = (swapped[6], swapped[5]);
        check(overviewQuery.Returns(declared) && overviewQuery.Returns([.. declared.Select((column, index) => (column.column, index == 3 ? typeof(int) : typeof(decimal)))])
            && !overviewQuery.Returns(swapped) && !overviewQuery.Returns(declared.Take(8).ToList()) && !overviewQuery.Returns([.. declared, ("extra", typeof(long))])
            && !overviewQuery.Returns([.. declared.Select((column, index) => (column.column, index == 2 ? typeof(string) : typeof(long)))]),
            "a live query's result must have the columns it declares, by name, in order and numeric: two swapped, one missing, one extra or a text column are refused");
        check(LiveSql.Prologue("server", readCommittedSnapshot: true) == LiveSql.UncommittedPrologue && LiveSql.Prologue("ssisdb", false) == LiveSql.UncommittedPrologue
            && LiveSql.Prologue("ssisdb", true) == LiveSql.CommittedPrologue && LiveSql.Isolation(LiveSql.UncommittedPrologue) == "readUncommitted" && LiveSql.Isolation(LiveSql.CommittedPrologue) == "readCommitted"
            && LiveSql.UncommittedPrologue.Contains("SET LOCK_TIMEOUT " + LiveSql.LockTimeoutMs + ";", StringComparison.Ordinal) && LiveSql.UncommittedPrologue.Contains("SET DEADLOCK_PRIORITY LOW;", StringComparison.Ordinal),
            "server DMVs read uncommitted; SSISDB reads committed only with READ_COMMITTED_SNAPSHOT on; both wait 1 s for a lock and lose any deadlock");
        ServerProfile Profile(int major, int edition) => new(major, null, edition, null, false, true, false);
        check(LiveConnections.Pool("server", "SSISDB") == (null, " - Activity Monitor") && LiveConnections.Pool("ssisdb", "SSISDB") == ("SSISDB", " - Integration Services")
            && LiveConnections.Pool("ssisdb", "VariaScratch_x_ssis") == ("VariaScratch_x_ssis", " - Integration Services")
            && LiveConnections.Band(Profile(16, 3)) == 16 && LiveConnections.Band(Profile(12, 8)) == LiveSql.MaxBand && LiveConnections.Band(Profile(18, 3)) == LiveSql.MaxBand
            && LiveConnections.Band(Profile(12, 3)) == 12 && LiveConnections.ServerStatePermission(Profile(16, 2)) == "VIEW SERVER PERFORMANCE STATE"
            && LiveConnections.ServerStatePermission(Profile(15, 2)) == "VIEW SERVER STATE" && LiveConnections.ServerStatePermission(Profile(12, 8)) == "VIEW SERVER STATE",
            "server probes use the \" - Activity Monitor\" pool and SSISDB the \" - Integration Services\" one, in the catalog's database (the checks' fake one too); Managed Instance runs the newest band; 2022 and later ask for VIEW SERVER PERFORMANCE STATE");
    }

    private static LiveRawSample Raw(long? ms, long? start, double?[] values, double?[]? bases = null) => new(ms, start, values, bases ?? new double?[values.Length]);

    private static void DeltaChecks(Action<bool, string> check)
    {
        var deltas = new LiveDeltas(["gauge", "rate", "msPerSecond", "ratio", "cpuPercent"]);
        var first = deltas.Apply(Raw(10_000, 1, [5, 100, 50, 10, 1000], [null, null, null, 100, 4]), null, 1000, "baseline");
        var second = deltas.Apply(Raw(12_000, 1, [6, 300, 250, 30, 5000], [null, null, null, 140, 4]), 2100, 1000, null);
        check(first.Gap == "baseline" && first.Values.SequenceEqual([5.0, null, null, null, null]) && first.ElapsedMs is null
            && second.Gap is null && second.ElapsedMs == 2000 && second.Values.SequenceEqual([6.0, 100.0, 100.0, 0.5, 50.0]),
            "a baseline has gauges and no rates; the next sample's rates use the server's clock (Δms_ticks 2,000, not the backend's 2,100): rate and ms per second, ratio over the base's change, CPU across the schedulers");
        var full = deltas.Apply(Raw(13_000, 1, [6, 300, 250, 30, 20_000], [null, null, null, 140, 4]), null, 1000, null);
        check(full.Values[3] is null && full.Values[4] == 100 && full.Gap is null, "a ratio whose base did not move has no value, and CPU is clamped to 100 %");
        var dropped = deltas.Apply(Raw(14_000, 1, [7, 100, 300, 31, 21_000], [null, null, null, 141, 4]), null, 1000, null);
        check(dropped.Gap == "reset" && dropped.Values[1] is null && dropped.Values[2] == 50 && dropped.Values[3] == 1 && dropped.Values[4] == 25,
            "a counter that went down (cleared) rebaselines alone, marked reset, and the others keep their rates");
        // Counters that happen to be higher after the restart: only the start time shows it.
        var restarted = deltas.Apply(Raw(15_000, 2, [8, 500, 400, 40, 30_000], [null, null, null, 150, 4]), null, 1000, null);
        var after = deltas.Apply(Raw(16_000, 2, [8, 510, 400, 40, 30_000], [null, null, null, 150, 4]), null, 1000, null);
        check(restarted.Gap == "reset" && restarted.Values.Skip(1).All(value => value is null) && restarted.Values[0] == 8 && after.Values[1] == 10 && after.Gap is null,
            "a server restart (the start time moved) drops every baseline, then rates resume from the new one");
        var resumed = deltas.Apply(Raw(19_500, 2, [8, 600, 400, 40, 30_000], [null, null, null, 150, 4]), null, 1000, "resumed");
        var late = deltas.Apply(Raw(23_500, 2, [8, 640, 400, 40, 30_000], [null, null, null, 150, 4]), null, 1000, null);
        check(resumed.Gap == "resumed" && resumed.Values[1] is null && late.Gap == "late" && late.Values[1] == 10 && late.ElapsedMs == 4000,
            "after a pause the first sample has no rates (the paused time is never a spike), and a sample over 3 intervals late keeps its rate but is marked late");
        deltas.Reset();
        var reopened = deltas.Apply(Raw(24_500, 2, [8, 650, 400, 40, 30_000], [null, null, null, 150, 4]), null, 1000, null);
        var client = new LiveDeltas(["rate"]);
        client.Apply(Raw(null, null, [10]), null, 1000, "baseline");
        var measured = client.Apply(Raw(null, null, [30]), 500, 1000, null);
        check(reopened.Gap == "baseline" && reopened.Values[1] is null && measured.Values[0] == 40 && measured.ElapsedMs == 500,
            "a reset (a broken connection) makes the next sample a baseline, and a probe without the server clock uses the backend's");

        var keyed = new LiveKeyedDeltas(capacity: 2);
        var firstRates = keyed.Apply("51\u001f2026-10-22T10:00:00", [100], 1000);
        keyed.EndSample();
        var secondRates = keyed.Apply("51\u001f2026-10-22T10:00:00", [400], 1000);
        var reused = keyed.Apply("51\u001f2026-10-22T10:05:00", [500], 1000);
        keyed.EndSample();
        var third = keyed.Apply("52\u001f2026-10-22T10:06:00", [1], 1000);
        check(firstRates[0] is null && secondRates[0] == 300 && reused[0] is null && third[0] is null && keyed.Count == 2,
            "per-row rates key on an identity column: a reused session id with a new login time gets no delta from the old session, and baselines stop at the row cap");
        keyed.EndSample();
        keyed.EndSample();
        check(keyed.Count == 0, "a key absent from two samples in a row is dropped");
    }

    private static readonly LiveIntervalJson AnyInterval = new(1000, 1000, 3_600_000);
    private static LiveProbeJson Probe(string id, int minGapMs = 0, double duty = 0.25, List<LiveTableJson>? tables = null) =>
        new(id, "fx", id, id, AnyInterval, [new("v", "count", "V", "gauge")], tables ?? [], [], [], "none", MinGapMs: minGapMs, MaxDutyCycle: duty);
    private static readonly LiveTableJson AppendTable = new("log", "append", [new("id", "id", "bigint")], ["id"]);
    private static readonly LiveTableJson SnapshotTable = new("rows", "snapshot", [new("k", "k", "int")], ["k"]);
    private static readonly LiveCatalog Fixture = LiveCatalog.Create(LiveCatalog.Current.Limits,
        [Probe("fx.a", minGapMs: 15_000, duty: 0.2), Probe("fx.b"), Probe("fx.app", tables: [SnapshotTable, AppendTable])],
        [new("fx", "Fixture", "Fixture", "server", false, ["fx.a", "fx.b", "fx.app"])]);

    private static LiveSubscription Subscription(ILiveSampler sampler, Func<double> random, params (string Probe, int Interval)[] probes)
    {
        var context = new RequestContext(1, "live.subscribe", RequestLane.Live, 0, Credit, sendCreditedEvent: (_, _) => 10);
        return new(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "server:X", Fixture.Sources["fx"], [.. probes.Select(item => new LiveProbeState(Fixture.Probes[item.Probe], item.Interval))],
            sampler, context, Fixture.Limits, random);
    }

    /// <summary>One sample, with the gap its source reports (a source with deltas says baseline whenever it has no rates).</summary>
    private static LiveSampleBatch Sample(string probe, int cost = 0, string? gap = null, int? skipped = null) => new([new LiveSample(probe, cost, 0, Gap: gap, Skipped: skipped)], []);
    /// <summary>The sample a source with deltas makes of a due item: its gap as the schedule saw it.</summary>
    private static LiveSampleBatch Echo(IReadOnlyList<LiveDue> due) => new([.. due.Select(item => new LiveSample(item.Probe.Spec.Id, 0, 0, Gap: item.Gap, Skipped: item.Skipped))], []);
    private static LiveSampleBatch Error(string probe, string code, bool terminal = false) => new([], [new LiveProbeError(probe, code, "Failed.", null, 0, terminal)]);

    private static void ScheduleChecks(Action<bool, string> check)
    {
        var sql = new ScriptedSampler(periodMs: null);
        // Phases: within a quarter of the shortest period's first second, the same for every probe.
        using (var late = Subscription(sql, () => 0.999, ("fx.a", 2000), ("fx.b", 5000)))
        using (var early = Subscription(sql, () => 0, ("fx.a", 2000)))
        {
            late.Opened([], 1000);
            early.Opened([], 1000);
            check(late.Probes.All(probe => probe.DueAt == 1249) && early.Probes[0].DueAt == 1000, "a subscription starts within a random quarter of its first second, one phase for all its probes, so they share ticks");
        }

        // Fixed rate, the quick second sample, and late slots skipped rather than replayed.
        using (var subscription = Subscription(sql, () => 0, ("fx.b", 2000)))
        {
            var probe = subscription.Probes[0];
            subscription.Opened([], 0);
            var first = subscription.TakeDue(0);
            subscription.Complete(first, Echo(first), 5);
            var quick = probe.DueAt;
            var second = subscription.TakeDue(1000);
            subscription.Complete(second, Sample("fx.b"), 1003);
            var slot = probe.DueAt;
            var lateDue = subscription.TakeDue(7500);
            check(first is [{ Gap: "baseline", ElapsedMs: null, BudgetMs: 1600, EffectiveIntervalMs: 2000 }] && quick == 1000 && second is [{ Gap: null, ElapsedMs: 1000 }] && slot == 3000
                && lateDue is [{ Gap: "late", Skipped: 2 }] && probe.DueAt == 9000 && subscription.TakeDue(7600).Count == 0 && subscription.WaitMs(7600) == 1400,
                "a baseline brings the second sample within a second; the schedule is fixed rate; slots missed are counted (late, skipped 2) and never replayed in a burst");
        }

        // Error back-off: the first failure retries at the interval, then doubles up to 60 s (jitter at its centre here).
        using (var subscription = Subscription(sql, () => 0.5, ("fx.b", 1000)))
        {
            var probe = subscription.Probes[0];
            subscription.Opened([], 0);
            var retries = new List<int>();
            long now = 0;
            for (var i = 0; i < 8; i++)
            {
                now = Math.Max(now, probe.DueAt);
                var due = subscription.TakeDue(now);
                var batch = subscription.Complete(due, Error("fx.b", "BLOCKED"), now);
                retries.Add(batch.Errors[0].RetryInMs);
                check(probe.DueAt == now + batch.Errors[0].RetryInMs, "a failed probe is next due after its retry delay (" + i + ")");
            }
            now = probe.DueAt;
            var recovered = subscription.Complete(subscription.TakeDue(now), Sample("fx.b"), now);
            now = probe.DueAt;
            var again = subscription.Complete(subscription.TakeDue(now), Error("fx.b", "TIMEOUT"), now);
            check(retries.SequenceEqual([1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000]) && probe.Failures == 1 && recovered.Samples.Count == 1 && again.Errors[0].RetryInMs == 1000,
                "failures back off: the interval, then doubling to the 60 s cap, and a success starts the count again: " + string.Join(", ", retries));
        }
        int Jittered(double random)
        {
            using var subscription = Subscription(sql, () => random, ("fx.b", 1000));
            subscription.Opened([], 0);
            var probe = subscription.Probes[0];
            subscription.Complete(subscription.TakeDue(probe.DueAt), Error("fx.b", "SQL_ERROR"), probe.DueAt);
            return subscription.Complete(subscription.TakeDue(probe.DueAt), Error("fx.b", "SQL_ERROR"), probe.DueAt).Errors[0].RetryInMs;
        }
        check(Jittered(0) == 1800 && Jittered(0.999) is > 2190 and <= 2200, "retry delays carry ±10 % jitter");

        // BUDGET never backs off (memory may free at any moment); a terminal error stops the probe until a refresh.
        using (var subscription = Subscription(sql, () => 0, ("fx.b", 1000), ("fx.a", 1000)))
        {
            var (b, a) = (subscription.Probes[0], subscription.Probes[1]);
            subscription.Opened([new LiveOpenedProbe("fx.a", 1000, 1000, 1000, "unavailable", "PERMISSION_DENIED", "No permission.")], 0);
            var budget = subscription.Complete(subscription.TakeDue(0), Error("fx.b", "BUDGET"), 0);
            var at = b.DueAt;
            var budgetAgain = subscription.Complete(subscription.TakeDue(at), Error("fx.b", "BUDGET"), at);
            var budgetFailures = b.Failures;
            var gated = a.Stopped is { Code: "PERMISSION_DENIED", Terminal: true } && a.Gated && subscription.AllStopped() is null;
            var stopped = subscription.Complete(subscription.TakeDue(b.DueAt), Error("fx.b", "NOT_SUPPORTED", terminal: true), b.DueAt);
            var all = subscription.AllStopped();
            var idle = subscription.WaitMs(5000);
            subscription.Refresh(5000);
            check(budget.Errors[0].RetryInMs <= 1000 && budgetAgain.Errors[0].RetryInMs == 1000 && budgetFailures == 0 && gated && stopped.Errors[0].RetryInMs == 0 && all?.Code == "NOT_SUPPORTED" && idle == -1
                && b.Stopped is null && b.DueAt == 5000 && a.Stopped is not null && subscription.WaitMs(5000) == 0,
                "BUDGET retries at the interval without backing off; a terminal error stops its probe (all stopped ends the view with the first's code); a refresh restarts it, but never one the source opened unavailable");
        }

        // The load guard: 3 costly samples double the interval in force; 10 cheap ones halve it back, never below the asked one.
        using (var subscription = Subscription(sql, () => 0, ("fx.a", 1000)))
        {
            var probe = subscription.Probes[0];
            subscription.Opened([], 0);
            var reported = new List<int>();
            void Run(int cost, int times)
            {
                for (var i = 0; i < times; i++)
                {
                    var now = probe.DueAt;
                    reported.Add(subscription.Complete(subscription.TakeDue(now), Sample("fx.a", cost), now).Samples[0].EffectiveIntervalMs);
                }
            }
            Run(300, 3);
            var doubled = reported.ToList();
            Run(300, 6);
            var held = probe.EffectiveIntervalMs;
            Run(0, 12);
            var halved = probe.EffectiveIntervalMs;
            Run(100_000, 30);
            check(doubled.SequenceEqual([1000, 1000, 2000]) && held == 2000 && halved == 1000 && probe.EffectiveIntervalMs == 60_000 && reported.Min() == 1000,
                "a probe costing over its duty cycle (0.2) for 3 samples slows to twice its interval, holds while its cost fits, steps back after 10 cheap samples, and never passes the 60 s cap: " + string.Join(", ", reported.Distinct()));
            var applied = probe.EffectiveIntervalMs;
            subscription.SetInterval(probe, 5000);
            check(applied == 60_000 && probe.EffectiveIntervalMs == 5000 && probe.CostEwma is null, "a new interval from an update starts the load guard again");
        }

        // Refresh honours the minimum gap; pause and resume; a shorter interval moves the next slot up.
        using (var subscription = Subscription(sql, () => 0, ("fx.a", 60_000), ("fx.b", 60_000)))
        {
            var (a, b) = (subscription.Probes[0], subscription.Probes[1]);
            subscription.Opened([], 0);
            var opening = subscription.TakeDue(0);
            subscription.Complete(opening, Echo(opening), 0);
            subscription.Complete(subscription.TakeDue(1000), new([new LiveSample("fx.a", 0, 0), new LiveSample("fx.b", 0, 0)], []), 1000);
            var slot = a.DueAt;
            subscription.Refresh(3000);
            check(slot == 61_000 && a.DueAt == 16_000 && b.DueAt == 3000, "refresh makes a probe due now, but never within its minimum gap (15 s) of its last sample");
            subscription.SetPaused(true, 3000);
            var paused = subscription.TakeDue(100_000).Count == 0 && subscription.WaitMs(100_000) == -1;
            subscription.SetPaused(false, 100_000);
            var resumed = subscription.TakeDue(100_000);
            subscription.Complete(resumed, Echo(resumed), 100_000);
            check(paused && resumed.Count == 2 && resumed.All(item => item.Gap == "resumed") && a.DueAt == 101_000,
                "a paused subscription has nothing due; resuming samples at once, marked resumed, with the quick second sample after");
            subscription.Complete(subscription.TakeDue(101_000), new([new LiveSample("fx.a", 0, 0), new LiveSample("fx.b", 0, 0)], []), 101_000);
            var before = b.DueAt;
            subscription.SetInterval(b, 5000);
            check(before == 161_000 && b.DueAt == 106_000 && b.BudgetMs == 4000 && a.BudgetMs == 5000, "a shorter interval moves the next sample up; the budget is 0.8 × the interval within 500 ms to 5 s");
        }

        // The quick second sample follows what the source reports: a baseline after a failed first attempt (the schedule saw
        // an attempt) or after a lost connection (the source started its rates again), never with slots skipped.
        using (var subscription = Subscription(sql, () => 0, ("fx.b", 10_000)))
        {
            var probe = subscription.Probes[0];
            subscription.Opened([], 0);
            subscription.Complete(subscription.TakeDue(0), Error("fx.b", "TIMEOUT"), 800);
            var retry = subscription.TakeDue(probe.DueAt);
            var afterFailure = subscription.Complete(retry, Sample("fx.b", gap: "baseline"), 10_050);
            var quickAfterFailure = probe.DueAt;
            subscription.Complete(subscription.TakeDue(probe.DueAt), Sample("fx.b"), 11_020);
            var steady = probe.DueAt;
            subscription.Complete(subscription.TakeDue(steady), Error("fx.b", "CONNECTION_LOST"), steady + 20);
            var late = probe.DueAt + 25_000;
            var lateDue = subscription.TakeDue(late);
            var afterLost = subscription.Complete(lateDue, Sample("fx.b", gap: "baseline", skipped: lateDue[0].Skipped), late + 30);
            check(retry is [{ Gap: null }] && afterFailure.Samples[0].Gap == "baseline" && quickAfterFailure == 11_000 && steady == 21_000
                && lateDue is [{ Gap: "late", Skipped: 2 }] && afterLost.Samples[0] is { Gap: "baseline", Skipped: null } && probe.DueAt == late + 1000,
                "a source's baseline after a failed first attempt or a lost connection brings the second sample within a second, and carries no skipped slots: "
                + quickAfterFailure + ", " + (probe.DueAt - late));
        }

        // Idle between samples: the wait after a 30 s probe's sample is a little under 30 s, and still gives the connection back;
        // not before a quick second sample, nor between the samples of a shorter interval.
        bool IdleAfter(int interval)
        {
            using var subscription = Subscription(sql, () => 0, ("fx.b", interval));
            var probe = subscription.Probes[0];
            subscription.Opened([], 0);
            var first = subscription.TakeDue(0);
            subscription.Complete(first, Echo(first), 20);
            var beforeQuick = subscription.IdleFor(subscription.WaitMs(20));
            subscription.Complete(subscription.TakeDue(probe.DueAt), Sample("fx.b"), 1020);
            return !beforeQuick && subscription.IdleFor(subscription.WaitMs(1020));
        }
        using (var paused = Subscription(sql, () => 0, ("fx.b", 1000)))
        {
            paused.Opened([], 0);
            paused.SetPaused(true, 0);
            check(IdleAfter(30_000) && IdleAfter(60_000) && !IdleAfter(20_000) && paused.IdleFor(paused.WaitMs(0)),
                "the source gives back its connection between the samples of probes at 30 s or slower (the wait being a little under 30 s), never before a quick second sample or at 20 s, and while paused");
        }

        // Refresh never outruns the probe's minimum interval, and never cuts a back-off short or forgets it; a refresh of a
        // probe a terminal error stopped starts its count again.
        using (var subscription = Subscription(sql, () => 0.5, ("fx.b", 60_000)))
        {
            var probe = subscription.Probes[0];
            subscription.Opened([], 0);
            var first = subscription.TakeDue(0);
            subscription.Complete(first, Echo(first), 10);
            subscription.Complete(subscription.TakeDue(1000), Sample("fx.b"), 1010);
            subscription.Refresh(1500);
            var floored = probe.DueAt;
            subscription.Complete(subscription.TakeDue(2000), Sample("fx.b"), 2010);
            check(floored == 2000, "a refresh runs a probe no sooner than its minimum interval (1 s) after its last attempt, so refreshes in a loop never outrun it: " + floored);
        }
        using (var subscription = Subscription(sql, () => 0.5, ("fx.b", 1000)))
        {
            var probe = subscription.Probes[0];
            subscription.Opened([], 0);
            for (var i = 0; i < 3; i++) subscription.Complete(subscription.TakeDue(probe.DueAt), Error("fx.b", "BLOCKED"), probe.DueAt);
            var (dueAt, failures) = (probe.DueAt, probe.Failures);
            var at = probe.LastSampleAt + 1500;
            subscription.Refresh(at);
            var kept = probe.DueAt == dueAt && probe.Failures == failures && failures == 3 && dueAt > at;
            subscription.Complete(subscription.TakeDue(probe.DueAt), Error("fx.b", "NOT_SUPPORTED", terminal: true), probe.DueAt);
            var stoppedAt = probe.LastSampleAt;
            subscription.Refresh(stoppedAt + 5000);
            var restarted = probe.Stopped is null && probe.Failures == 0 && probe.DueAt == stoppedAt + 5000;
            var again = subscription.Complete(subscription.TakeDue(probe.DueAt), Error("fx.b", "BLOCKED"), probe.DueAt);
            check(kept && restarted && again.Errors[0].RetryInMs == 1000 && probe.Failures == 1,
                "a refresh during back-off keeps the delay and the failure count; one after a terminal error restarts the probe, whose next failure retries at the interval");
        }
    }

    private static async Task GateChecks(Action<bool, string> check)
    {
        var gates = new LiveGates(2, 3);
        var a1 = await gates.WaitAsync("a", 50, CancellationToken.None);
        var a2 = await gates.WaitAsync("a", 50, CancellationToken.None);
        var started = Environment.TickCount64;
        var a3 = await gates.WaitAsync("a", 100, CancellationToken.None);
        var waited = Environment.TickCount64 - started;
        var b1 = await gates.WaitAsync("b", 50, CancellationToken.None);
        var c1 = await gates.WaitAsync("c", 50, CancellationToken.None);
        check(a1 is not null && a2 is not null && a3 is null && waited >= 90 && b1 is not null && c1 is null && gates.Busy == 3,
            "live statements take a gate per connection (2) and one in the backend (here 3); a wait over its budget gives up with nothing held");
        var queued = gates.WaitAsync("a", 5000, CancellationToken.None);
        await Task.Delay(50);
        var stillWaiting = !queued.IsCompleted;
        a1!.Dispose();
        a1.Dispose();
        var acquired = await queued;
        check(stillWaiting && acquired is not null && gates.Busy == 3, "a waiting statement gets the gate as soon as one is released (a lease releases once)");
        using var stop = new CancellationTokenSource(50);
        var cancelled = false;
        try { await gates.WaitAsync("c", 5000, stop.Token); }
        catch (OperationCanceledException) { cancelled = true; }
        foreach (var lease in new[] { a2, b1, acquired }) lease!.Dispose();
        check(cancelled && gates.Busy == 0, "a cancelled wait holds nothing");

        // A unary method on lane live shares the gates: BUSY when they stay full past its wait, else it runs.
        var service = new LiveService(new FixtureHost(new() { ["x"] = "server:X", ["y"] = "server:Y" }, new ResultStore(1L << 20, 1L << 19)), Fixture);
        var held = new List<IDisposable?>();
        for (var i = 0; i < 2; i++) held.Add(await service.Gates.WaitAsync("x", 50, CancellationToken.None));
        string? busy = null;
        try { await service.RunGatedAsync("x", 50, _ => Task.FromResult(1), CancellationToken.None); }
        catch (RequestException error) { busy = error.Code; }
        var other = await service.RunGatedAsync("y", 50, _ => Task.FromResult(7), CancellationToken.None);
        foreach (var lease in held) lease?.Dispose();
        var freed = await service.RunGatedAsync("x", 50, _ => Task.FromResult(9), CancellationToken.None);
        check(busy == "BUSY" && other == 7 && freed == 9 && service.Gates.Busy == 0 && Fixture.Limits.StatementsPerConnection == 2,
            "a unary request on lane live runs under the live gates: BUSY when its connection's 2 stay taken past its wait, and it runs once one frees");

        // Gates exist only for connected ids: an id a request names never adds one, a cancelled wait adds nothing, and a gate
        // whose id went away while it was held (a disconnect racing the wait) goes with its last lease.
        var known = service.Gates.Connections;
        string? unknown = null;
        try { await service.RunGatedAsync(Guid.NewGuid().ToString(), 50, _ => Task.FromResult(1), CancellationToken.None); }
        catch (RequestException error) { unknown = error.Code; }
        var connected = new HashSet<string> { "z", "w" };
        var tracked = new LiveGates(2, 8, id => { lock (connected) return connected.Contains(id); });
        var cancelledWait = false;
        try { await tracked.WaitAsync("w", 50, new CancellationToken(canceled: true)); }
        catch (OperationCanceledException) { cancelledWait = true; }
        var heldZ = await tracked.WaitAsync("z", 50, CancellationToken.None);
        var whileHeld = tracked.Connections;
        lock (connected) connected.Remove("z");
        heldZ!.Dispose();
        check(unknown == "NOT_CONNECTED" && service.Gates.Connections == known && cancelledWait && whileHeld == 1 && tracked.Connections == 0 && tracked.Busy == 0,
            "a live gate exists only for a connected id: an unknown one is NOT_CONNECTED and adds none, a cancelled wait adds none, and one whose id went away goes with its last lease");
    }

    private static void ResumeChecks(Action<bool, string> check)
    {
        var probes = new[] { Fixture.Probes["fx.app"], Fixture.Probes["fx.b"] };
        var max = Fixture.Limits.ResumeCharacters;
        var token = LiveResume.Encode("fx", [new LiveCursor("fx.app", 1, 42)], max);
        var parsed = token is null ? [] : LiveResume.Parse(token, "fx", probes, max);
        check(token is { Length: <= 256 } && LiveService.IsResumeToken(token) && parsed.SequenceEqual([new LiveCursor("fx.app", 1, 42)]) && LiveResume.Decode(token).Contains("\"cursors\"", StringComparison.Ordinal),
            "a resume token is base64url of the source and each append table's settled id, and parses back to the same cursors");
        string Forge(string json) => Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(json)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        var refused = new Dictionary<string, string>
        {
            ["other source"] = LiveResume.Encode("other", [new LiveCursor("fx.app", 1, 42)], max)!,
            ["unknown probe"] = Forge("{\"v\":1,\"source\":\"fx\",\"cursors\":[[\"fx.zz\",1,42]]}"),
            ["snapshot table"] = Forge("{\"v\":1,\"source\":\"fx\",\"cursors\":[[\"fx.app\",0,42]]}"),
            ["no such table"] = Forge("{\"v\":1,\"source\":\"fx\",\"cursors\":[[\"fx.app\",2,42]]}"),
            ["probe without append"] = Forge("{\"v\":1,\"source\":\"fx\",\"cursors\":[[\"fx.b\",0,42]]}"),
            ["twice"] = Forge("{\"v\":1,\"source\":\"fx\",\"cursors\":[[\"fx.app\",1,42],[\"fx.app\",1,43]]}"),
            ["negative"] = Forge("{\"v\":1,\"source\":\"fx\",\"cursors\":[[\"fx.app\",1,-1]]}"),
            ["unsafe"] = Forge("{\"v\":1,\"source\":\"fx\",\"cursors\":[[\"fx.app\",1,9007199254740992]]}"),
            ["version"] = Forge("{\"v\":2,\"source\":\"fx\",\"cursors\":[]}"),
            ["extra member"] = Forge("{\"v\":1,\"source\":\"fx\",\"cursors\":[],\"x\":1}"),
            ["repeated member"] = Forge("{\"v\":1,\"v\":1,\"source\":\"fx\",\"cursors\":[]}"),
            ["not json"] = Forge("cursors"),
            ["padding"] = token + "=",
            ["not canonical"] = token![..^1] + (token[^1] == 'A' ? "B" : "A"),
            ["too long"] = new string('A', 257)
        };
        var accepted = refused.Where(item =>
        {
            try { LiveResume.Parse(item.Value, "fx", probes, max); return true; }
            catch (RequestException error) { return error.Code != "INVALID_PARAMS"; }
        }).Select(item => item.Key).ToList();
        check(accepted.Count == 0 && LiveResume.Encode("fx", [.. Enumerable.Range(0, 32).Select(index => new LiveCursor("fx.app", index, long.MaxValue / 2))], max) is null,
            "a resume token is parsed strictly (INVALID_PARAMS for another source, an unknown probe or table, a repeat, an unsafe id, any other shape), and one over 256 characters is never made: " + string.Join(", ", accepted));
    }

    private static void ErrorChecks(Action<bool, string> check)
    {
        var expected = new Dictionary<(int, byte), string>
        {
            [(1222, 16)] = "BLOCKED", [(1205, 13)] = "BLOCKED", [(297, 16)] = "PERMISSION_DENIED", [(300, 14)] = "PERMISSION_DENIED", [(229, 14)] = "PERMISSION_DENIED",
            [(208, 16)] = "NOT_SUPPORTED", [(207, 16)] = "NOT_SUPPORTED", [(4060, 11)] = "DATABASE_UNAVAILABLE", [(942, 14)] = "DATABASE_UNAVAILABLE",
            [(-2, 11)] = "TIMEOUT", [(10054, 20)] = "CONNECTION_LOST", [(0, 20)] = "CONNECTION_LOST", [(233, 16)] = "CONNECTION_LOST", [(8134, 16)] = "SQL_ERROR",
            [(18456, 14)] = "LOGIN_FAILED", [(18486, 14)] = "LOGIN_FAILED", [(18487, 14)] = "LOGIN_FAILED", [(18488, 14)] = "LOGIN_FAILED", [(18452, 14)] = "LOGIN_FAILED"
        };
        var wrong = expected.Where(item => LiveErrors.Classify(item.Key.Item1, item.Key.Item2) != item.Value).Select(item => item.Key.Item1 + "/" + item.Key.Item2).ToList();
        check(wrong.Count == 0 && LiveErrors.IsTerminal("PERMISSION_DENIED") && LiveErrors.IsTerminal("NOT_SUPPORTED") && LiveErrors.IsTerminal("LOGIN_FAILED") && LiveErrors.IsTerminal("CATALOG_MISSING")
            && !LiveErrors.IsTerminal("BLOCKED") && !LiveErrors.IsTerminal("DATABASE_UNAVAILABLE")
            && LiveErrors.Breaks("CONNECTION_LOST") && LiveErrors.Breaks("TIMEOUT") && !LiveErrors.Breaks("BLOCKED"),
            "SQL errors map to live codes: lock timeouts and deadlocks BLOCKED, permission errors PERMISSION_DENIED (terminal), unknown objects NOT_SUPPORTED (terminal), offline databases DATABASE_UNAVAILABLE, transport errors CONNECTION_LOST, a refused sign-in (failed, locked out, expired, untrusted) LOGIN_FAILED (terminal, so a reconnect never repeats it alone): " + string.Join(", ", wrong));
        var long_ = LiveErrors.Create("activity.overview", "SQL_ERROR", new string('x', 5000));
        var signIn = LiveErrors.SignIn("activity.overview", new RequestException("AUTH_UNSUPPORTED", "Install the GSSAPI library."));
        check(long_.Message.Length == 2000 && !long_.Terminal && signIn is { Code: "AUTH_KERBEROS", Terminal: false } && signIn.Message == "Install the GSSAPI library."
            && new[] { LiveErrors.BlockedMessage, LiveErrors.TimeoutMessage, LiveErrors.PermissionMessage, LiveErrors.UnsupportedMessage, LiveErrors.UnavailableMessage, LiveErrors.LostMessage, LiveErrors.BusyMessage, LiveErrors.LoginFailedMessage }.All(message => message.EndsWith('.')),
            "probe error messages are complete sentences of at most 2,000 characters, and a sign-in failure keeps its own advice");
        // An SSISDB source that cannot open the catalog's database, by its sys.databases row (state, user_access).
        var missing = LiveErrors.Catalog(LiveSql.CatalogProbe, null, null);
        var offline = LiveErrors.Catalog(LiveSql.CatalogProbe, 6, 0);
        var restoring = LiveErrors.Catalog(LiveSql.CatalogProbe, 1, 0);
        var single = LiveErrors.Catalog(LiveSql.CatalogProbe, 0, 1);
        var closed = LiveErrors.Catalog(LiveSql.CatalogProbe, 0, 0);
        var restricted = LiveErrors.Catalog(LiveSql.CatalogProbe, 0, 2);
        check(missing is { Code: "CATALOG_MISSING", Terminal: true, Message: LiveErrors.CatalogMissingMessage } && offline is { Code: "DATABASE_UNAVAILABLE", Terminal: false }
            && restoring is { Code: "DATABASE_UNAVAILABLE", Terminal: false } && single is { Code: "DATABASE_UNAVAILABLE", Terminal: false } && restricted is { Code: "DATABASE_UNAVAILABLE", Terminal: false }
            && closed is { Code: "PERMISSION_DENIED", Terminal: true, Message: LiveErrors.CatalogAccessMessage } && LiveErrors.CatalogMissingMessage.EndsWith('.') && LiveErrors.CatalogAccessMessage.EndsWith('.'),
            "an SSISDB source whose catalog database cannot be opened says why: none (CATALOG_MISSING, terminal), offline, restoring, single-user or restricted to its owners for maintenance (DATABASE_UNAVAILABLE, retried), or closed to the login (PERMISSION_DENIED, terminal)");
        // Only an open that does not say why (4060, 916) is looked up in sys.databases; one that says the database is unavailable
        // (alone, or before or after 4060) stays DATABASE_UNAVAILABLE, so a readable row never turns it into a terminal refusal.
        int[] unavailable = [911, 922, 924, 926, 927, 942, 945, 952, 976, 978];
        var lookedUp = new[] { ConnectionFailureChecks.Sql(4060), ConnectionFailureChecks.Sql(916), ConnectionFailureChecks.Sql(4060, 18456) }.All(LiveErrors.OpensNoDatabase);
        var wrongUnavailable = unavailable.Where(number => LiveErrors.OpensNoDatabase(ConnectionFailureChecks.Sql(number)) || LiveErrors.OpensNoDatabase(ConnectionFailureChecks.Sql(number, 4060))
            || LiveErrors.OpensNoDatabase(ConnectionFailureChecks.Sql(4060, number)) || LiveErrors.From(LiveSql.CatalogProbe, ConnectionFailureChecks.Sql(number, 4060)).Code != "DATABASE_UNAVAILABLE").ToList();
        check(lookedUp && wrongUnavailable.Count == 0 && !LiveErrors.OpensNoDatabase(ConnectionFailureChecks.Sql(229)) && !LiveErrors.OpensNoDatabase(ConnectionFailureChecks.Sql(18456)),
            "an SSISDB source looks the catalog's database up only when its open fails without saying why (4060, 916); one that says it is unavailable stays DATABASE_UNAVAILABLE: " + string.Join(", ", wrongUnavailable));
    }

    private static async Task LoopChecks(Action<bool, string> check)
    {
        var connection = Guid.NewGuid().ToString();
        var store = new ResultStore(1L << 20, 1L << 19);
        uint next = 100;
        async Task<(LiveEnd? End, LiveRecorder Recorder, ScriptedSampler Sampler, string Id, LiveService Service)> Start(Action<ScriptedSampler>? setup = null, bool acknowledge = true,
            string[]? probes = null, string? resume = null, int? periodMs = 10, Func<LiveRecorder, bool>? until = null, Action<LiveService, string>? during = null)
        {
            var sampler = new ScriptedSampler(periodMs);
            setup?.Invoke(sampler);
            var service = new LiveService(new FixtureHost(new() { [connection] = "server:F" }, store), Fixture) { TestSampler = _ => sampler, Random = () => 0 };
            var recorder = new LiveRecorder(++next, acknowledge);
            var id = Guid.NewGuid().ToString();
            var task = service.SubscribeAsync(new LiveSubscribeArgs(id, connection, "fx", [.. (probes ?? ["fx.b"]).Select(probe => new LiveProbeArgs(probe, 1000))], Resume: resume), recorder.Context, HostChecks.Json);
            if (until is not null) await recorder.WaitAsync(until);
            during?.Invoke(service, id);
            if (await Task.WhenAny(task, Task.Delay(until is null ? 3000 : 300)) != task) service.CancelAll();
            LiveEnd? end = null;
            try { end = await task.WaitAsync(TimeSpan.FromSeconds(10)); }
            catch (RequestException) { }
            return (end, recorder, sampler, id, service);
        }

        // Stop and wait: nothing is sampled while the opened frame is unacknowledged.
        {
            var sampler = new ScriptedSampler(10);
            using var service = new LiveService(new FixtureHost(new() { [connection] = "server:F" }, store), Fixture) { TestSampler = _ => sampler };
            using var recorder = new LiveRecorder(1, acknowledge: false);
            var task = service.SubscribeAsync(new LiveSubscribeArgs(Guid.NewGuid().ToString(), connection, "fx", [new LiveProbeArgs("fx.b", 1000)]), recorder.Context, HostChecks.Json);
            await recorder.WaitAsync(r => r.Opened is not null);
            await Task.Delay(300);
            var before = sampler.Calls;
            recorder.Grant();
            var after = await recorder.WaitAsync(r => r.Ticks.Count == 1, 3000);
            await Task.Delay(200);
            check(recorder.Opened is not null && before == 0 && after && sampler.Calls == 1 && recorder.Ticks.Count == 1,
                "the scheduler runs no probe while a frame is unacknowledged: nothing before the opened frame's acknowledgement, one tick after it, and nothing more until that is acknowledged");
            service.CancelAll();
            await task;
        }

        // A slow probe never overlaps itself: one task per subscription, one tick at a time.
        var slow = await Start(sampler => sampler.DelayMs = 40, until: r => r.Ticks.Count >= 5);
        check(slow.Sampler.MostAtOnce == 1 && slow.Recorder.Ticks.Count >= 5 && slow.End?.Ended == "shutdown", "a sample that takes longer than the period never overlaps the next one");

        // Every probe stopped for good ends the view failed with the first one's code; so does a source with nothing available.
        var denied = await Start(sampler => sampler.Next = due => new([], [.. due.Select(item => LiveErrors.Create(item.Probe.Spec.Id, "PERMISSION_DENIED", LiveErrors.PermissionMessage))]));
        var unavailable = await Start(sampler => sampler.Opened["fx.b"] = new("fx.b", 1000, 1000, 1000, "unavailable", "NOT_SUPPORTED", LiveErrors.UnsupportedMessage));
        check(denied.End is { Ended: "failed", Code: "PERMISSION_DENIED", Ticks: 1 } && denied.Recorder.Ticks[0].Errors is [{ Terminal: true, RetryInMs: 0 }]
            && unavailable.End is { Ended: "failed", Code: "NOT_SUPPORTED", Ticks: 0 } && unavailable.Sampler.Calls == 0 && unavailable.Recorder.Opened?.Probes[0].State == "unavailable",
            "when every probe has stopped for good (a terminal error, or opened unavailable) the subscription ends failed with that code and runs nothing more");

        // A failure's retry is in the tick; the sampler's new session id is in the tick.
        var failing = await Start(sampler => sampler.Next = due => new([], [LiveErrors.Create(due[0].Probe.Spec.Id, "BLOCKED", LiveErrors.BlockedMessage)], Spid: 77), until: r => r.Ticks.Count >= 2);
        check(failing.Recorder.Ticks[0] is { Spid: 77, Errors: [{ Code: "BLOCKED", RetryInMs: 10 }] } && failing.Recorder.Ticks[1].Errors is [{ RetryInMs: >= 18 and <= 22 }],
            "a tick names the probe's retry delay (the period, then doubled with jitter) and the session the source reopened");

        // Paused: the source is told to give back its connection while nothing is due.
        var idle = await Start(until: r => r.Ticks.Count >= 1, during: (service, id) =>
        {
            service.Update(new LiveUpdateArgs(id, "fx", Paused: true), HostChecks.Json);
            Thread.Sleep(200);
        });
        check(idle.Sampler.Idles >= 1, "while every probe is paused the source gives back its connection (Idle)");
        var slowPeriod = await Start(periodMs: 30_000, until: r => r.Ticks.Count >= 1, during: (_, _) => Thread.Sleep(200));
        check(slowPeriod.Sampler.Idles >= 1 && slowPeriod.Sampler.Calls == 1, "between the samples of a 30 s probe the source gives back its connection (Idle) without a pause");

        // A refused sign-in on reconnect stops the probe: no attempt follows on its own, and the view ends failed.
        var signIn = await Start(sampler => sampler.Next = due => new([], [.. due.Select(item => LiveErrors.Create(item.Probe.Spec.Id, LiveErrors.Classify(18456, 14), LiveErrors.LoginFailedMessage))]));
        check(signIn.End is { Ended: "failed", Code: "LOGIN_FAILED", Ticks: 1 } && signIn.Sampler.Calls == 1 && signIn.Recorder.Ticks[0].Errors is [{ Terminal: true, RetryInMs: 0 }],
            "a login the server refuses while the view reconnects (18456) stops the probe with no further attempt, and the view ends failed LOGIN_FAILED");

        // Resume: a moved cursor puts a token in the tick and the end; subscribing with it hands the source its cursors.
        var cursors = await Start(sampler => sampler.Next = due => new([.. due.Select(item => new LiveSample(item.Probe.Spec.Id, 0, 0))], [], Cursors: [new LiveCursor("fx.app", 1, 42)]),
            probes: ["fx.app"], until: r => r.Ticks.Count >= 3);
        var token = cursors.Recorder.Ticks[0].Resume;
        var resumed = await Start(probes: ["fx.app"], resume: token, until: r => r.Ticks.Count >= 1);
        var refused = false;
        try { await Start(probes: ["fx.app"], resume: LiveResume.Encode("other", [new LiveCursor("fx.app", 1, 1)], 256)); }
        catch (RequestException error) { refused = error.Code == "INVALID_PARAMS"; }
        string? refusedCode = null;
        try
        {
            using var recorder = new LiveRecorder(999);
            using var service = new LiveService(new FixtureHost(new() { [connection] = "server:F" }, store), Fixture) { TestSampler = _ => new ScriptedSampler() };
            await service.SubscribeAsync(new LiveSubscribeArgs(Guid.NewGuid().ToString(), connection, "fx", [new LiveProbeArgs("fx.app", 1000)], Resume: "AAAA"), recorder.Context, HostChecks.Json);
        }
        catch (RequestException error) { refusedCode = error.Code; }
        check(token is not null && cursors.Recorder.Ticks.Skip(1).All(tick => tick.Resume is null) && cursors.End?.Resume == token
            && resumed.Sampler.ResumedFrom?.SequenceEqual([new LiveCursor("fx.app", 1, 42)]) == true && resumed.End?.Resume == token && refusedCode == "INVALID_PARAMS",
            "a tick carries a resume token only when a cursor moved, the end carries the last one, and a subscription resumed with it hands its source the cursors; a malformed one is refused");

        // The connection id went away under the source: the subscription ends disconnected.
        var gone = await Start(sampler => sampler.Next = _ => throw new RequestException("NOT_CONNECTED", "Connect to a SQL Server first."));
        check(gone.End is { Ended: "disconnected" }, "a source whose connection id is gone ends its subscription disconnected");
    }

    /// <summary>SqlSampler against a host whose server never finishes a login: no SQL for a view subscribed paused, and a
    /// connect that holds no live gate and ends at its own bound as a TIMEOUT value.</summary>
    private static async Task SamplerChecks(Action<bool, string> check)
    {
        var id = Guid.NewGuid().ToString();
        var activity = LiveCatalog.Current.Sources["activity"];
        var overview = LiveCatalog.Current.Probes[LiveSql.OverviewProbe];
        {
            var host = new HangingHost(id);
            using var sampler = new SqlSampler(host, new LiveGates(2, 8, host.IsConnected), id, activity, null) { ConnectBudgetMs = 200 };
            var opening = await sampler.OpenAsync([new LiveProbeState(overview, 2000) { Paused = true }], [], CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(5));
            check(host.Pooled == 0 && host.Opens == 0 && opening is { Spid: null, Probes: [{ State: "ok" }] },
                "a view subscribed with every probe paused opens no connection and runs no SQL (the session is read when a probe first runs)");
        }
        {
            var host = new HangingHost(id);
            // One gate in the backend: were the connect holding it, the other connection could not have it.
            var gates = new LiveGates(2, 1, other => other == id || other == "other");
            using var sampler = new SqlSampler(host, gates, id, activity, null) { ConnectBudgetMs = 400 };
            var probe = new LiveProbeState(overview, 2000);
            var opening = await sampler.OpenAsync([probe], [], CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(5));
            var sampling = sampler.SampleAsync([new LiveDue(probe, null, null, null, null, new Dictionary<int, LiveTrackArgs>(), probe.BudgetMs, 2000)], CancellationToken.None);
            await Task.Delay(100);
            var busyWhileConnecting = gates.Busy;
            using (var lease = await gates.WaitAsync("other", 50, CancellationToken.None)) check(lease is not null && busyWhileConnecting == 0 && !sampling.IsCompleted,
                "a live connect holds no gate: while one server does not answer a login, a view on another connection still gets the backend's only gate");
            var batch = await sampling.WaitAsync(TimeSpan.FromSeconds(5));
            check(opening is { Spid: null, Probes: [{ State: "ok" }] } && batch is { Samples: [], Errors: [{ Code: "TIMEOUT", Number: null, Terminal: false }] } && host.Opens == 2 && gates.Busy == 0,
                "a connect that never finishes ends at its own bound: the opened frame still goes (state ok, session unknown) and the next sample is a TIMEOUT value, holding nothing");
        }
        {
            // The catalog's database will not open (4060), so the sampler reads why in the login's own database; the subscription
            // is cancelled during that read, which SqlClient reports as a SqlException of its own.
            var host = new ScriptedOpenHost(id);
            using var service = new LiveService(host);
            using var recorder = new LiveRecorder(7);
            var lookups = 0;
            host.Open = (connection, token) =>
            {
                if (connection.Database.Length > 0) throw ConnectionFailureChecks.Sql(4060);
                Interlocked.Increment(ref lookups);
                recorder.Context.Cancel(CancelReason.User);
                throw ConnectionFailureChecks.Sql(0, 0, 11, "server", "Operation cancelled by user.");
            };
            var task = service.SubscribeAsync(new LiveSubscribeArgs(Guid.NewGuid().ToString(), id, "ssis.catalog", [new LiveProbeArgs(LiveSql.CatalogProbe, 10_000)]), recorder.Context, HostChecks.Json);
            string ended;
            try { ended = (await task.WaitAsync(TimeSpan.FromSeconds(10))).Ended; }
            catch (Exception error) { ended = error.GetType().Name; }
            check(lookups == 1 && ended == "cancelled" && service.Gates.Busy == 0,
                "a subscription cancelled while an SSISDB source reads why its catalog's database will not open ends cancelled, however SqlClient words the cancel: " + ended);
        }
    }

    /// <summary>The activity source through SqlService, with no SQL Server: refused as values before any connection.</summary>
    private static async Task ServiceChecks(Action<bool, string> check)
    {
        using var service = new SqlService(new ResultStore(1L << 20, 1L << 19));
        async Task<string?> Code(object args)
        {
            using var context = new RequestContext(1, "live.subscribe", RequestLane.Live, 0, Credit, sendCreditedEvent: (_, _) => 10);
            try { await service.DispatchAsync("live.subscribe", JsonSerializer.SerializeToElement(args, HostChecks.Json), HostChecks.Json, context); return null; }
            catch (RequestException error) { return error.Code; }
        }
        object Subscribe(object? args = null) => new
        {
            subscriptionId = Guid.NewGuid().ToString(), connectionId = Guid.NewGuid().ToString(), source = "activity",
            probes = new[] { new { probe = LiveSql.OverviewProbe, intervalMs = 2000 } }, args
        };
        var plain = await Code(Subscribe());
        var withArgs = await Code(Subscribe(new { rows = 1 }));
        check(plain == "NOT_CONNECTED" && withArgs == "INVALID_PARAMS" && service.Live.Count == 0,
            "a production backend (no test hooks) accepts the activity source, which needs a connected id (NOT_CONNECTED), and refuses args it does not take");
    }
}
