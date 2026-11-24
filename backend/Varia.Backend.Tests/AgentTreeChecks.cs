using System.Globalization;
using System.Text.Json;
using Varia.Backend.Live;
using Varia.Backend.Protocol;

namespace Varia.Backend.Tests;

/// <summary>AG-12's <c>agent.tree</c> change source: its probe's text offline (every band linted, declared and guarded), and live
/// (with VARIA_TEST_SQL_AGENT=1 and VARIA_TEST_SQL_SCRATCH=1) a subscription that sees an operator created and renamed
/// elsewhere, and the probe's state values with Agent stopped (Agent XPs 0), in the AgentService suite.</summary>
internal static class AgentTreeChecks
{
    private static string Literal(string value) => "N'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";
    private static string Dump(object? value) => JsonSerializer.Serialize(value, new JsonSerializerOptions(JsonSerializerDefaults.Web));

    public static Task RunAsync(Action<bool, string> check)
    {
        var spec = LiveCatalog.Current.Probes[LiveSql.AgentTreeProbe];
        var problems = new List<string>();
        for (var band = LiveSql.MinBand; band <= LiveSql.MaxBand; band++)
        {
            var query = LiveSql.For(LiveSql.AgentTreeProbe, band);
            if (query is null) { problems.Add(band + ": no query"); continue; }
            problems.AddRange(LiveSql.Lint(query.Text(LiveSql.UncommittedPrologue)).Select(problem => band + ": " + problem));
            problems.AddRange(query.Problems(spec).Select(problem => band + ": " + problem));
            if (!query.Status!.Select(status => status.Status).SequenceEqual(spec.Status)) problems.Add(band + ": status values differ from the catalogue's, in order");
            if (!query.Returns([.. query.Columns.Select(column => (column, column.EndsWith("_count", StringComparison.Ordinal) || column.EndsWith("_checksum", StringComparison.Ordinal) ? typeof(long) : typeof(int)))]))
                problems.Add(band + ": its columns are not the ones declared");
            // Each table only under its own permission guard, so a login that may not read one gets 0 and 0, never an error.
            foreach (var (id, table, _) in LiveSql.AgentTreeFingerprints)
                if (!query.Body.Contains("IF ISNULL(HAS_PERMS_BY_NAME(N'" + table + "', N'OBJECT', N'SELECT'), 0) = 1\n    SELECT @" + id + "_n = COUNT_BIG(*)", StringComparison.Ordinal)) problems.Add(band + ": " + id + " is not read under its guard");
            // The state part is explorer.agentService's own text, without its SELECT.
            var service = LiveSql.AgentServiceAt(band);
            if (!query.Body.StartsWith(service[..service.LastIndexOf("SELECT @xps", StringComparison.Ordinal)], StringComparison.Ordinal)) problems.Add(band + ": its state part is not explorer.agentService's");
        }
        check(problems.Count == 0 && LiveSql.For(LiveSql.AgentTreeProbe, LiveSql.MinBand - 1) is null && spec is { Source: "agent.tree", Permission: "none", Series.Count: 0, Tables.Count: 0 }
            && LiveCatalog.Current.Sources["agent.tree"] is { Scope: "server", TestOnly: false } source && source.Probes.SequenceEqual([LiveSql.AgentTreeProbe])
            && spec.Status.SequenceEqual(["agentXps", "serviceState", .. LiveSql.AgentTreeFingerprints.SelectMany(table => new[] { table.Id + "Count", table.Id + "Checksum" })]),
            "agent.treeProbe (AG-12) has one query per band from 2016 that passes the live lint, fits its catalogue entry, sends Agent XPs, the service state and each "
            + "msdb table's count and checksum in the catalogue's order, reads each table under its own HAS_PERMS_BY_NAME guard, and reuses explorer.agentService's "
            + "state text: " + string.Join(" | ", problems));
        return Task.CompletedTask;
    }

    /// <summary>The live catalogue with the tree probe allowed to run every second, so the checks need not wait 5 s between samples.</summary>
    private static LiveCatalog Fast()
    {
        var current = LiveCatalog.Current;
        return LiveCatalog.Create(current.Limits, current.Probes.Values.Select(probe => probe.Id == LiveSql.AgentTreeProbe ? probe with { IntervalMs = probe.IntervalMs with { Min = 1000 } } : probe),
            current.Sources.Values);
    }

    private static Dictionary<string, long>? Status(LiveTickEvent? tick) =>
        tick?.Samples.FirstOrDefault(sample => sample.Probe == LiveSql.AgentTreeProbe)?.Status?.ToDictionary(value => value.Id, value => Convert.ToInt64(value.Value, CultureInfo.InvariantCulture));

    /// <summary>A live subscription to agent.tree as sysadmin on a server whose Agent is up: its first sample reads Agent XPs 1 and
    /// sysjobs_view's own row count; an operator created elsewhere (this run's scratch operator) moves the operators count up one,
    /// renaming it moves only the operators checksum, and dropping it brings the count back. The operator is dropped in finally.</summary>
    public static async Task LiveAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, JsonSerializerOptions json, ScratchDatabase scratch,
        Func<string, string, Task<SqlRun>> sql)
    {
        using var live = new LiveService(service, Fast());
        var recorder = new LiveRecorder(9700);
        var task = live.SubscribeAsync(new LiveSubscribeArgs(Guid.NewGuid().ToString(), info.Id, "agent.tree", [new LiveProbeArgs(LiveSql.AgentTreeProbe, 1000)]), recorder.Context, json);
        var name = scratch.AgentObject("op");
        var renamed = name + "x";
        try
        {
            var samples = () => recorder.Ticks.Select(Status).Where(status => status is not null).Select(status => status!).ToList();
            // Only samples taken after the step before it count, so an earlier sample never stands in for the change.
            var from = 0;
            async Task<Dictionary<string, long>?> NextAsync(Func<Dictionary<string, long>, bool> condition)
            {
                var start = from;
                await recorder.WaitAsync(view => samples().Skip(start).Any(condition) || view.Ticks.Any(tick => tick.Errors is not null) || task.IsCompleted, 30_000);
                var found = samples().Skip(start).FirstOrDefault(condition);
                return found;
            }
            var first = await NextAsync(_ => true);
            var jobs = long.Parse((await sql("SELECT COUNT_BIG(*) FROM msdb.dbo.sysjobs_view;", "master")).Scalar ?? "-1", CultureInfo.InvariantCulture);
            var errors = recorder.Ticks.SelectMany(tick => tick.Errors ?? []).ToList();
            check(first is not null && errors.Count == 0 && recorder.Opened is { Source: "agent.tree", Spid: > 0, Probes: [{ State: "ok" }] } && first["agentXps"] == 1
                && first["jobsCount"] == jobs && first.Keys.Order(StringComparer.Ordinal).SequenceEqual(LiveCatalog.Current.Probes[LiveSql.AgentTreeProbe].Status.Where(id => id != "serviceState" || first.ContainsKey(id)).Order(StringComparer.Ordinal)),
                "agent.tree samples a live server as sysadmin: Agent XPs 1 and sysjobs_view's " + jobs + " jobs, every status value: " + Dump(first) + Dump(errors));
            if (first is null) return;
            from = samples().Count;
            var created = await sql("EXEC msdb.dbo.sp_add_operator @name = " + Literal(name) + ", @enabled = 1;", "msdb");
            var added = await NextAsync(status => status["operatorsCount"] == first["operatorsCount"] + 1);
            check(created.Status == "completed" && added is not null && added["operatorsChecksum"] != first["operatorsChecksum"] && added["jobsChecksum"] == first["jobsChecksum"],
                "an operator created elsewhere moves only the operators fingerprint of agent.tree's next sample: " + created.Error + " " + Dump(added));
            if (added is null) return;
            from = samples().Count;
            var update = await sql("EXEC msdb.dbo.sp_update_operator @name = " + Literal(name) + ", @new_name = " + Literal(renamed) + ";", "msdb");
            var moved = await NextAsync(status => status["operatorsChecksum"] != added["operatorsChecksum"]);
            check(update.Status == "completed" && moved is not null && moved["operatorsCount"] == added["operatorsCount"] && moved["alertsChecksum"] == added["alertsChecksum"],
                "renaming that operator elsewhere moves its checksum and not its count: " + update.Error + " " + Dump(moved));
            from = samples().Count;
            var dropped = await sql("EXEC msdb.dbo.sp_delete_operator @name = " + Literal(renamed) + ";", "msdb");
            var back = await NextAsync(status => status["operatorsCount"] == first["operatorsCount"]);
            check(dropped.Status == "completed" && back is not null && back["operatorsChecksum"] == first["operatorsChecksum"],
                "dropping it brings the operators fingerprint back to what it was: " + dropped.Error + " " + Dump(back));
        }
        finally
        {
            recorder.Context.Cancel(CancelReason.User);
            await task.WaitAsync(TimeSpan.FromSeconds(15));
            recorder.Dispose();
            foreach (var each in new[] { name, renamed })
                await sql("IF EXISTS (SELECT 1 FROM msdb.dbo.sysoperators WHERE name = " + Literal(each) + ") EXEC msdb.dbo.sp_delete_operator @name = " + Literal(each) + ";", "msdb");
        }
    }

    /// <summary>agent.treeProbe's Agent XPs and service state as one read of its text at the server's band reports them (the
    /// AgentService suite reads it with Agent stopped and running again).</summary>
    public static async Task<(string? Xps, string? State, string? Error)> StateAsync(Func<string, string, Task<SqlRun>> sql)
    {
        var major = int.Parse((await sql("SELECT CONVERT(int, SERVERPROPERTY('ProductMajorVersion'));", "master")).Scalar ?? "0", CultureInfo.InvariantCulture);
        var query = LiveSql.For(LiveSql.AgentTreeProbe, Math.Clamp(major, LiveSql.MinBand, LiveSql.MaxBand))!;
        var run = await sql(query.Text(LiveSql.UncommittedPrologue), "master");
        return run.Sets is [[var row, ..], ..] ? (row[0], row[1], run.Error) : (null, null, run.Error ?? run.Status);
    }
}
