using System.Text.Json;
using Varia.Backend.Agent;
using Varia.Backend.Explorer;
using Varia.Backend.Live;
using Varia.Backend.Protocol;

namespace Varia.Backend.Tests;

/// <summary>Offline checks of the agent.jobs live source (AG-3): its args, and AgentJobsReader against a fake server: Job Activity
/// Monitor's rows, tones, views, column value filters, tiles, elapsed times and the expanded job's last run; the service probe's
/// unknown values; the status bar's watched slots; and refusals as values.</summary>
internal static class AgentJobsChecks
{
    private static readonly Guid Nightly = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid Backup = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid Purge = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid Retry = Guid.Parse("44444444-4444-4444-4444-444444444444");

    public static async Task RunAsync(Action<bool, string> check)
    {
        Args(check);
        Helpers(check);
        await ListAsync(check);
        await FailuresAsync(check);
        await WatchedAsync(check);
        await ServiceAsync(check);
    }

    private static void Args(Action<bool, string> check)
    {
        var catalog = AgentCatalog.Current;
        bool Refused(AgentJobsLiveArgs args)
        {
            try { AgentJobsArgs.Check(args, catalog); return false; }
            catch (RequestException error) when (error.Code == "INVALID_PARAMS") { return true; }
        }
        var id = Nightly.ToString();
        check(!Refused(new()) && !Refused(new(id, [id, Backup.ToString()], [new("status", ["Executing"]), new("category", null, Blanks: true)]))
            && Refused(new("not-a-uuid")) && Refused(new(Watch: [])) && Refused(new(Watch: [id, id.ToUpperInvariant()]))
            && Refused(new(Watch: [id, Backup.ToString(), Purge.ToString(), Retry.ToString()]))
            && Refused(new(Filters: [new("owner", ["sa"])])) && Refused(new(Filters: [new("status", ["a"]), new("status", ["b"])]))
            && Refused(new(Filters: [new("status")])) && Refused(new(Filters: [new("status", [new string('x', 129)])]))
            && Refused(new(Filters: [new("status", [.. Enumerable.Range(0, 65).Select(at => "v" + at)])])) && Refused(new(Filters: [new("status", ["a"], NonBlanks: true, Exclude: true)])),
            "agent.jobs' args take an expanded job id, up to agentLimits.watchedJobs distinct watched job ids and one value filter per faceted column (status, lastOutcome, category) of up to 64 values of up to 128 characters, as main's schema does");
    }

    private static void Helpers(Action<bool, string> check)
    {
        check(AgentJobsReader.ParseStep("2 (Rebuild indexes)") == (2, "Rebuild indexes") && AgentJobsReader.ParseStep("0 (unknown)") == (null, null) && AgentJobsReader.ParseStep(null) == (null, null)
            && AgentJobsReader.ParseStep("3") == (3, null),
            "current_execution_step's \"2 (Rebuild indexes)\" is step 2 named Rebuild indexes; \"0 (unknown)\" (idle) is no step");
        check(AgentJobsReader.When(20261115, 23000) == new DateTime(2026, 11, 15, 2, 30, 0) && AgentJobsReader.When(0, 0) is null && AgentJobsReader.When(20261131, 0) is null
            && AgentJobsReader.DecodeDuration(1_020_304) == 102 * 3600 + 3 * 60 + 4 && AgentJobsReader.DecodeDuration(170) is null && AgentJobsReader.Duration(3725) == "01:02:05"
            && AgentJobsReader.Stamp(new DateTime(2026, 11, 15, 2, 30, 5)) == 20261115023005d,
            "msdb's integer dates, times and durations decode as the catalogue's table tests do (0 is never, hours past 99 are more digits), and a stamp is yyyymmddhhmmss");
    }

    private static object?[] JobRow(AgentStatement statement, Guid id, string name, int enabled, int status, string step, int outcome, int lastDate, int lastTime, int steps, int retry = 0,
        string category = "Database Maintenance") => [.. statement.Columns.Select(column => (object?)(column switch
    {
        "job_id" => id, "name" => name, "enabled" => (byte)enabled, "category" => category, "owner" => "sa", "date_created" => new DateTime(2026, 1, 2, 3, 4, 5, 678),
        "date_modified" => new DateTime(2026, 1, 2), "version_number" => 1, "last_run_date" => lastDate, "last_run_time" => lastTime, "last_run_outcome" => outcome,
        "next_run_date" => enabled == 1 ? 20261116 : 0, "next_run_time" => enabled == 1 ? 23000 : 0, "current_execution_status" => status, "current_execution_step" => step,
        "has_step" => steps, "has_schedule" => enabled, "current_retry_attempt" => retry, _ => null
    }))];

    private static object?[] HistoryRow(AgentStatement statement, int instance, int step, string name, int status, int date, int time, int duration, string message) =>
        [.. statement.Columns.Select(column => (object?)(column switch
        {
            "instance_id" => instance, "job_id" => Nightly, "step_id" => step, "step_name" => name, "sql_message_id" => 0, "sql_severity" => 0, "message" => message, "run_status" => status,
            "run_date" => date, "run_time" => time, "run_duration" => duration, "retries_attempted" => 0, _ => null
        }))];

    private static AgentReader Fake(List<string> ran, Func<AgentStatement, object?, AgentResult?>? answer = null) => new()
    {
        TestRun = (statement, values, _) =>
        {
            ran.Add(statement.Id);
            var job = values.GetValueOrDefault("@job_id");
            if (answer?.Invoke(statement, job) is { } given) return Task.FromResult(given);
            var s = statement;
            List<object?[]> rows = statement.Id switch
            {
                "jobActivity" => [
                    JobRow(s, Nightly, "Nightly", 1, 4, "0 (unknown)", 0, 20261115, 23000, 3, category: "ETL"),
                    JobRow(s, Backup, "Backup", 1, 1, "2 (Copy files)", 1, 20261115, 10000, 4),
                    JobRow(s, Purge, "Purge", 0, 4, "0 (unknown)", 3, 20261101, 60000, 1),
                    JobRow(s, Retry, "Retry", 1, 3, "1 (Back up log)", 0, 20261115, 141500, 1, retry: 2)],
                "activities" => [[Backup, new DateTime(2026, 11, 15, 14, 0, 0), null], [Nightly, new DateTime(2026, 11, 15, 2, 30, 0), new DateTime(2026, 11, 15, 2, 48, 42)]],
                "clock" => [[new DateTime(2026, 11, 15, 14, 12, 4)]],
                "history" => [
                    HistoryRow(s, 10, 1, "Truncate", 1, 20261114, 23000, 2, "ok"), HistoryRow(s, 11, 0, "(Job outcome)", 1, 20261114, 23000, 2, "The job succeeded."),
                    HistoryRow(s, 12, 1, "Truncate", 1, 20261115, 23000, 2, "ok"), HistoryRow(s, 13, 2, "Load", 1, 20261115, 23002, 1631, "ok"),
                    HistoryRow(s, 14, 3, "Merge", 0, 20261115, 24633, 209, "Violation of PRIMARY KEY constraint " + new string('x', 600)),
                    HistoryRow(s, 15, 0, "(Job outcome)", 0, 20261115, 23000, 1842, "The job failed.")],
                "watchedJob" when job is Guid id && id == Backup => [JobRow(s, Backup, "Backup", 1, 1, "2 (Copy files)", 1, 20261115, 10000, 4)],
                "watchedJob" when job is Guid id && id == Nightly => [JobRow(s, Nightly, "Nightly", 1, 4, "0 (unknown)", 0, 20261115, 23000, 3)],
                _ => []
            };
            return Task.FromResult(new AgentResult(statement.Columns, rows, false));
        }
    };

    private static LiveDue Due(string probe, string? view = null) => new(new LiveProbeState(LiveCatalog.Current.Probes[probe], 5000), null, null, null, null, new Dictionary<int, LiveTrackArgs>(), View: view);
    private static string[] Texts(LiveRow row) => [.. row.Cells.Select(cell => cell.Text ?? "NULL")];
    private static int Col(string id) => Array.IndexOf(AgentJobsReader.Columns, id);

    private static async Task ListAsync(Action<bool, string> check)
    {
        var spec = LiveCatalog.Current.Probes[AgentJobsReader.ListProbe];
        check(spec.Tables[0].Columns.Select(column => column.Id).SequenceEqual(AgentJobsReader.Columns), "the reader builds the list's cells in the catalogue's column order");
        var ran = new List<string>();
        var reader = new AgentJobsReader(new(Nightly.ToString())) { Reader = Fake(ran) };
        var sample = await reader.ReadAsync(null!, LiveSql.UncommittedPrologue, Due(AgentJobsReader.ListProbe), null, CancellationToken.None);
        var rows = sample.Tables[0].Rows.ToDictionary(row => row.Cells[Col("name")].Text!, Texts);
        check(sample.Sampled && sample.Errors.Count == 0 && ran.SequenceEqual(["jobActivity", "activities", "clock", "history"]),
            "the list reads sp_help_job, then the activity rows and the server's clock because a job runs, then the expanded job's history: " + string.Join(", ", ran));
        check(rows["Backup"][Col("status")] == "Executing" && rows["Backup"][Col("step")] == "Step 2 of 4 · Copy files" && rows["Backup"][Col("tone")] == "running"
            && rows["Backup"][Col("elapsed")] == "00:12:04" && rows["Nightly"][Col("elapsed")] == "NULL"
            && rows["Retry"][Col("status")] == "Between retries" && rows["Retry"][Col("step")] == "Step 1 of 1 · Back up log (attempt 2)" && rows["Retry"][Col("tone")] == "warning"
            && rows["Nightly"][Col("lastOutcome")] == "Failed" && rows["Nightly"][Col("tone")] == "error" && rows["Nightly"][Col("step")] == "NULL"
            && rows["Purge"][Col("enabled")] == "No" && rows["Purge"][Col("tone")] == "muted" && rows["Purge"][Col("nextRun")] == "NULL" && rows["Purge"][Col("lastOutcome")] == "Canceled"
            && rows["Nightly"][Col("created")] == "2026-01-02T03:04:05" && rows["Nightly"][Col("jobId")] == Nightly.ToString().ToUpperInvariant()
            && rows["Nightly"][Col("lastRun")].StartsWith("2026-11-15 02:30:00", StringComparison.Ordinal),
            "a running job reads Executing with its step and how long it has run (from its activity row and the server's clock), between retries is toned warning with its attempt, a failed last run error, a disabled job muted with no next run, and Created is the identity's yyyy-MM-ddTHH:mm:ss: "
            + string.Join(" | ", rows.Values.Select(row => string.Join(",", row))));
        check(sample.Raw?.Values.SequenceEqual([2d, 2d, 1d, 1d]) == true, "the tiles count running (1, 2, 3, 7), last run failed, between retries and disabled jobs from the same read");
        var lastRun = sample.Tables[1].Rows.Select(Texts).ToList();
        check(lastRun.Select(row => row[1]).SequenceEqual(["1", "2", "3", "0"]) && lastRun[3][3] == "Failed" && lastRun[2][7] == "error" && lastRun[0][7] == "NULL"
            && lastRun[1][5] == "00:16:31" && lastRun[2][6].Length == (int)AgentCatalog.Current.Limit("gridMessageChars") && lastRun[2][6].EndsWith('…') && lastRun[3][2] == "(Job outcome)",
            "the expanded job's last run is the step rows after the previous job outcome row, then its own outcome row; messages are cut to gridMessageChars: " + string.Join(" | ", lastRun.Select(row => string.Join(",", row))));
        var cap = LiveCatalog.Current.Probes[AgentJobsReader.ListProbe].Tables[1].RowCap;
        var history = AgentSql.History;
        List<object?[]> many = [.. Enumerable.Range(1, cap + 10).Select(at => HistoryRow(history, at, 1 + at % 50, "Loop", 1, 20261115, 23000, 0, "ok")), HistoryRow(history, cap + 11, 0, "(Job outcome)", 1, 20261115, 23000, 5, "The job succeeded.")];
        var capped = reader.LastRun(new AgentResult(history.Columns, many, false)).Select(Texts).ToList();
        check(capped.Count == cap && capped[^1][2] == "(Job outcome)" && capped[0][0] == "12",
            "a run with more step rows than the last run table keeps keeps its newest steps and its outcome row: " + capped.Count + " rows, first " + capped[0][0] + ", last " + capped[^1][2]);
        bool Keeps(LiveReaderTable table, string name) => table.View?.Invoke(table.Rows.Single(row => row.Cells[Col("name")].Text == name)) ?? true;
        var running = (await reader.ReadAsync(null!, LiveSql.UncommittedPrologue, Due(AgentJobsReader.ListProbe, "running"), null, CancellationToken.None)).Tables[0];
        var failed = (await reader.ReadAsync(null!, LiveSql.UncommittedPrologue, Due(AgentJobsReader.ListProbe, "failed"), null, CancellationToken.None)).Tables[0];
        var disabled = (await reader.ReadAsync(null!, LiveSql.UncommittedPrologue, Due(AgentJobsReader.ListProbe, "disabled"), null, CancellationToken.None)).Tables[0];
        check(Keeps(running, "Backup") && Keeps(running, "Retry") && !Keeps(running, "Nightly") && Keeps(failed, "Nightly") && Keeps(failed, "Retry") && !Keeps(failed, "Backup")
            && Keeps(disabled, "Purge") && !Keeps(disabled, "Nightly"), "the running view keeps executing and between-retries jobs, failed the jobs whose last run failed, disabled the disabled ones");
        reader.Apply(new AgentJobsLiveArgs(Filters: [new("category", ["ETL"], Exclude: true)]));
        ran.Clear();
        var filtered = await reader.ReadAsync(null!, LiveSql.UncommittedPrologue, Due(AgentJobsReader.ListProbe, "failed"), null, CancellationToken.None);
        check(!Keeps(filtered.Tables[0], "Nightly") && Keeps(filtered.Tables[0], "Retry") && filtered.Tables[0].FacetScope?.Invoke(filtered.Tables[0].Rows.Single(row => row.Cells[Col("name")].Text == "Nightly")) == true
            && filtered.Tables[1].Rows.Count == 0 && !ran.Contains("history"),
            "a column value filter keeps rows on top of the view, the facets count the view's rows only (so a column's own filter never empties its list), and with no job expanded the last run is empty and unread");
    }

    private static async Task FailuresAsync(Action<bool, string> check)
    {
        var ran = new List<string>();
        var denied = new AgentJobsReader { Reader = Fake(ran, (statement, _) => statement.Id == "jobActivity" ? throw ConnectionFailureChecks.Sql(229, 5, 14, "server", "The EXECUTE permission was denied on the object 'sp_help_job'.") : null) };
        var sample = await denied.ReadAsync(null!, LiveSql.UncommittedPrologue, Due(AgentJobsReader.ListProbe), null, CancellationToken.None);
        check(!sample.Sampled && sample.Errors is [{ Code: "PERMISSION_DENIED", Terminal: true }] && !sample.Errors[0].Message.Contains("sp_", StringComparison.Ordinal),
            "a login msdb refuses sp_help_job fails the list with PERMISSION_DENIED (terminal), naming no procedure");
        var disabled = new AgentJobsReader { Reader = Fake(ran, (statement, _) => statement.Id == "jobActivity" ? throw ConnectionFailureChecks.Sql(15281, 1, 16, "server", "SQL Server blocked access to procedure 'dbo.sp_help_job' of component 'Agent XPs'.") : null) };
        var off = await disabled.ReadAsync(null!, LiveSql.UncommittedPrologue, Due(AgentJobsReader.ListProbe), null, CancellationToken.None);
        check(!off.Sampled && off.Errors is [{ Code: "AGENT_DISABLED", Terminal: true }], "a list read that raises 15281 stops the probe with AGENT_DISABLED, which the service probe's next XPs-1 sample restarts");
        var partial = new AgentJobsReader(new(Nightly.ToString()))
        {
            Reader = Fake(ran, (statement, _) => statement.Id is "history" or "activities" ? throw ConnectionFailureChecks.Sql(229, 5, 14, "server", "The EXECUTE permission was denied.") : null)
        };
        var some = await partial.ReadAsync(null!, LiveSql.UncommittedPrologue, Due(AgentJobsReader.ListProbe), null, CancellationToken.None);
        check(some.Sampled && some.Tables[0].Rows.Count == 4 && some.Tables[1].Rows.Count == 0 && some.Errors.Count == 2 && some.Errors.All(error => error.Code == "PERMISSION_DENIED")
            && some.Errors.Any(error => error.Tables is [1]) && some.Tables[0].Rows.All(row => row.Cells[Col("elapsed")].IsNull),
            "a refused activity or history read leaves only its own part empty (no elapsed time, no last run), as error values naming what they feed");
    }

    private static async Task WatchedAsync(Action<bool, string> check)
    {
        var ran = new List<string>();
        var gone = Guid.Parse("55555555-5555-5555-5555-555555555555");
        var reader = new AgentJobsReader(new(Watch: [Backup.ToString(), gone.ToString(), Nightly.ToString()]))
        {
            Reader = Fake(ran, (statement, job) => statement.Id == "watchedJob" && job is Guid id && id == gone ? throw ConnectionFailureChecks.Sql(14262, 1, 16, "server", "The specified @job_id does not exist.") : null)
        };
        var sample = await reader.ReadAsync(null!, LiveSql.UncommittedPrologue, Due(AgentJobsReader.WatchedProbe), null, CancellationToken.None);
        var values = sample.Raw!.Values;
        check(LiveCatalog.Current.Probes[AgentJobsReader.WatchedProbe].Series.Count == values.Length && values.Length == 18 && sample.Errors.Count == 0
            && values[..6].SequenceEqual([1d, 2d, 4d, 20261115140000d, 1d, 20261115010000d]) && values[6] == AgentJobsReader.GoneStatus && values[7..12].All(value => value is null)
            && values[12..].SequenceEqual([4d, null, 3d, null, 0d, 20261115023000d]),
            "each watched job fills its slot: status, current step, step count, start (from its activity row) while running, last outcome and last run; a job gone since (14262) reads status -1 and nothing else: "
            + string.Join(",", values.Select(value => value?.ToString() ?? "null")));
        var idle = new AgentJobsReader(new(Watch: [Nightly.ToString()])) { Reader = Fake(ran = []) };
        await idle.ReadAsync(null!, LiveSql.UncommittedPrologue, Due(AgentJobsReader.WatchedProbe), null, CancellationToken.None);
        check(ran.SequenceEqual(["watchedJob"]), "watched jobs that all idle read no activity rows");
    }

    private static async Task ServiceAsync(Action<bool, string> check)
    {
        var known = await new AgentJobsReader { TestService = () => (1, 4, 2) }.ReadAsync(null!, LiveSql.UncommittedPrologue, Due(AgentJobsReader.ServiceProbe), null, CancellationToken.None);
        var unknown = await new AgentJobsReader { TestService = () => (0, null, null) }.ReadAsync(null!, LiveSql.UncommittedPrologue, Due(AgentJobsReader.ServiceProbe), null, CancellationToken.None);
        check(known.Status?.Select(item => item.Id + "=" + item.Value).SequenceEqual(["agentXps=1", "serviceState=4", "startupType=2"]) == true
            && unknown.Status?.Select(item => item.Id + "=" + item.Value).SequenceEqual(["agentXps=0"]) == true,
            "the service probe reports Agent XPs always, and the service's state and startup type only where the login may read them (left out: unknown)");
        var reader = new AgentJobsReader();
        check(reader.Unavailable(LiveCatalog.Current.Probes[AgentJobsReader.ServiceProbe], new ServerProfile(16, "16.0", 3, "sa", false, true, false)) is null,
            "every agent.jobs probe runs where its catalogue gates let it (Express and the cloud editions are gated out there)");
    }

    /// <summary>The agent.jobs source on a live server whose Agent runs (the Agent live suite, after the scratch job ran once): one
    /// view of all three probes lists the job with SSMS's columns, reads its last run (its outcome row and its step), watches it
    /// in slot 0 with its last outcome, and reports Agent XPs on and the service running where the login may read it.</summary>
    public static async Task LiveAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, JsonSerializerOptions json, string job, Guid id)
    {
        var recorder = new LiveRecorder(9700);
        var args = JsonSerializer.SerializeToElement(new AgentJobsLiveArgs(id.ToString("D"), [id.ToString("D")]), json);
        var task = service.Live.SubscribeAsync(new LiveSubscribeArgs(Guid.NewGuid().ToString(), info.Id, AgentJobsReader.Source,
            [new LiveProbeArgs(AgentJobsReader.ListProbe, 2000), new LiveProbeArgs(AgentJobsReader.ServiceProbe, 5000), new LiveProbeArgs(AgentJobsReader.WatchedProbe, 2000)], args), recorder.Context, json);
        try
        {
            LiveSample? Last(LiveRecorder seen, string probe) => seen.Ticks.SelectMany(tick => tick.Samples).LastOrDefault(sample => sample.Probe == probe && (sample.Metrics is not null || sample.Status is not null || sample.Tables is not null));
            var sampled = await recorder.WaitAsync(seen => Last(seen, AgentJobsReader.ListProbe)?.Tables is { Count: 2 } && Last(seen, AgentJobsReader.ServiceProbe) is not null
                && Last(seen, AgentJobsReader.WatchedProbe)?.Metrics is { } watched && watched[4] is not null, 30_000);
            var list = Last(recorder, AgentJobsReader.ListProbe);
            var jobs = list?.Tables?.FirstOrDefault(table => table.Table == 0) is { } listed ? LiveResultChecks.RowsOf(service.Results, listed.Descriptor) : [];
            var lastRun = list?.Tables?.FirstOrDefault(table => table.Table == 1) is { } run ? LiveResultChecks.RowsOf(service.Results, run.Descriptor) : [];
            var row = jobs.FirstOrDefault(cells => cells[Col("name")] == job);
            var watched = Last(recorder, AgentJobsReader.WatchedProbe)?.Metrics;
            var status = Last(recorder, AgentJobsReader.ServiceProbe)?.Status?.ToDictionary(item => item.Id, item => Convert.ToInt64(item.Value, System.Globalization.CultureInfo.InvariantCulture));
            var errors = recorder.Ticks.SelectMany(tick => tick.Errors ?? []).Select(error => error.Probe + " " + error.Code).Distinct().ToList();
            check(sampled && row is not null && row[Col("status")] == "Idle" && row[Col("lastOutcome")] == "Succeeded" && row[Col("enabled")] == "Yes" && row[Col("runnable")] == "Yes"
                && string.Equals(row[Col("jobId")], id.ToString("D"), StringComparison.OrdinalIgnoreCase) && row[Col("created")]?.Length == 19
                && lastRun.Count == 2 && lastRun[0][2] == "Step 1" && lastRun[1][2] == "(Job outcome)" && lastRun[1][3] == "Succeeded"
                && watched is not null && watched[0] == 4 && watched[2] == 1 && watched[4] == 1 && watched[5] > 20_000_000_000_000d
                && status is not null && status.GetValueOrDefault("agentXps") == 1 && (!status.TryGetValue("serviceState", out var state) || state == 4) && errors.Count == 0,
                "agent.jobs on a live server lists the scratch job (Idle, last run Succeeded, its id and identity), reads its last run's step and outcome rows, watches it in slot 0 (idle, one step, Succeeded) and reports Agent XPs on: "
                + string.Join(",", row ?? []) + " | " + string.Join(" / ", lastRun.Select(cells => string.Join(",", cells))) + " | " + string.Join(",", watched ?? []) + " | "
                + string.Join(",", status?.Select(item => item.Key + "=" + item.Value) ?? []) + " | " + string.Join("; ", errors));
        }
        finally
        {
            recorder.Context.Cancel(CancelReason.User);
            await task.WaitAsync(TimeSpan.FromSeconds(10));
            recorder.Dispose();
        }
    }
}
