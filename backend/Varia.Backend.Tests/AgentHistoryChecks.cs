using Varia.Backend.Actions;
using Varia.Backend.Agent;
using Varia.Backend.Live;

namespace Varia.Backend.Tests;

/// <summary>Offline checks of the Log File Viewer (AG-5a): agent.history's args, the grouping of history rows into runs, AgentHistoryReader
/// against a fake server (tables, filters, regrouping without SQL, refusals as values), and Delete History's batch lint and validation.</summary>
internal static class AgentHistoryChecks
{
    private static readonly Guid Nightly = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid Backup = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly DateTime Day = new(2026, 11, 15);

    public static async Task RunAsync(Action<bool, string> check)
    {
        Args(check);
        Grouping(check);
        Lint(check);
        Validation(check);
        await ReaderAsync(check);
        await FailuresAsync(check);
    }

    private static void Args(Action<bool, string> check)
    {
        var catalog = AgentCatalog.Current;
        bool Refused(AgentHistoryLiveArgs args)
        {
            try { AgentHistoryArgs.Check(args, catalog); return false; }
            catch (RequestException error) when (error.Code == "INVALID_PARAMS") { return true; }
        }
        var id = Nightly.ToString();
        var many = Enumerable.Range(0, (int)catalog.Limit("historyJobs") + 1).Select(at => new Guid(at, 0, 0, new byte[8]).ToString()).ToArray();
        check(!Refused(new()) && !Refused(new([], 7, "failed", "error", 2, new(id, 15))) && !Refused(new([id, Backup.ToString()], 3650, Step: 0))
            && Refused(new(["not-a-uuid"])) && Refused(new([id, id.ToUpperInvariant()])) && Refused(new(many)) && Refused(new(Days: 0)) && Refused(new(Days: 3651))
            && Refused(new(Outcome: "xpsOff")) && Refused(new(Text: "")) && Refused(new(Text: new string('x', (int)catalog.Limit("searchChars") + 1)))
            && Refused(new(Step: -1)) && Refused(new(Step: 1001)) && Refused(new(Run: new("nope", 1))) && Refused(new(Run: new(id, 0))),
            "agent.history's args take up to historyJobs distinct job ids, a 1 to 3650 day window, one of the viewer's outcomes, a 1 to searchChars text, a 0 to 1000 step and a run by job id and instance, as main's schema does");
    }

    private static AgentHistoryRow Row(Guid job, int instance, int step, int status, int hour, int minute = 0, string? message = null) =>
        new(instance, job, step, step == 0 ? "(Job outcome)" : "Step " + step, 0, 0, message ?? (step == 0 ? "The job " + (status == 1 ? "succeeded." : "failed.") : "ok"), status, Day.AddHours(hour).AddMinutes(minute), 5, 0);

    private static void Grouping(Action<bool, string> check)
    {
        List<AgentHistoryRow> rows = [
            // Nightly: two finished runs, then a step of the run in progress.
            Row(Nightly, 1, 1, 1, 2), Row(Nightly, 2, 0, 1, 2),
            Row(Nightly, 3, 1, 1, 3), Row(Nightly, 4, 2, 0, 3, 1), Row(Nightly, 5, 0, 0, 3),
            Row(Nightly, 6, 1, 1, 4),
            // Backup: a step left by a run Agent never finished (it started before the next run's outcome row), then a run, then a step after it.
            Row(Backup, 10, 1, 1, 1), Row(Backup, 11, 1, 1, 2), Row(Backup, 12, 0, 1, 2), Row(Backup, 13, 1, 0, 5)
        ];
        var states = new Dictionary<Guid, AgentHistoryJobState> { [Nightly] = new(true, Day.AddHours(4)), [Backup] = new(false, null) };
        var runs = AgentHistoryReader.Group(rows, states, AgentOrphanLabel.Unknown);
        string Describe(AgentHistoryRun run) => run.Job == Nightly ? "N" : "B";
        var shape = runs.Select(run => Describe(run) + run.Key + ":" + run.OutcomeId + ":" + string.Join(",", run.Rows.Select(row => row.Instance))).ToList();
        check(shape.SequenceEqual(["N2:succeeded:2,1", "N5:failed:5,3,4", "N6:inProgress:6", "B12:succeeded:12,11", "B10:unknown:10", "B13:unknown:13"]),
            "a run is its job outcome row (listed first, keyed by its instance) with the step rows after the job's previous outcome row that started at or after it; a step of a running job after its last outcome row is In progress; one between outcome rows, or after the last of a job not running, is Unknown: "
            + string.Join(" | ", shape));
        var off = AgentHistoryReader.Group(rows, new Dictionary<Guid, AgentHistoryJobState>(), AgentOrphanLabel.XpsOff);
        check(off.Single(run => run.Job == Backup && run.Key == 13).OutcomeId == "xpsOff" && off.Single(run => run.Job == Nightly && run.Key == 6).OutcomeId == "xpsOff"
            && off.Single(run => run.Job == Backup && run.Key == 10).OutcomeId == "unknown",
            "with Agent XPs off and the service not read as stopped, steps after a job's last outcome row read In progress or unknown; steps between outcome rows stay Unknown");
        var earlier = new Dictionary<Guid, AgentHistoryJobState> { [Nightly] = new(true, Day.AddHours(5)) };
        var stale = AgentHistoryReader.Group(rows.Where(row => row.Job == Nightly), earlier, AgentOrphanLabel.Unknown);
        var unread = AgentHistoryReader.Group(rows.Where(row => row.Job == Nightly), new Dictionary<Guid, AgentHistoryJobState> { [Nightly] = new(true, null) }, AgentOrphanLabel.Unknown);
        check(stale.Single(run => run.Key == 6).OutcomeId == "unknown" && unread.Single(run => run.Key == 6).OutcomeId == "inProgress",
            "a running job's steps that started before its current start are an unfinished older run (Unknown); with the start unreadable they all read In progress");
        var bounded = AgentHistoryReader.Group([Row(Backup, 20, 2, 1, 0), Row(Backup, 21, 0, 1, 1), Row(Backup, 22, 1, 1, 6), Row(Backup, 23, 0, 1, 6)], states, AgentOrphanLabel.Unknown);
        var windowIdle = AgentHistoryReader.Group([Row(Backup, 40, 2, 1, 1), Row(Backup, 41, 3, 1, 2)], states, AgentOrphanLabel.Unknown);
        var windowRunning = AgentHistoryReader.Group([Row(Backup, 40, 2, 1, 1), Row(Backup, 41, 3, 1, 2)], new Dictionary<Guid, AgentHistoryJobState> { [Backup] = new(true, Day) }, AgentOrphanLabel.Unknown);
        check(windowIdle is [{ OutcomeId: "unknown", Key: 40 }] && windowRunning is [{ OutcomeId: "inProgress" }],
            "an idle job's steps with no outcome row are a run Agent never finished (Unknown), in a date window too; a running job's are In progress");
        check(bounded.Select(run => run.OutcomeId + run.Key).SequenceEqual(["succeeded21", "unknown20", "succeeded23"]),
            "a step row before an outcome row that started earlier than its run is a crashed run of its own (Unknown), whichever window was read; the window filter keeps or drops it by its start");
        var running = AgentHistoryReader.Group([Row(Backup, 30, 0, 1, 1), Row(Backup, 31, 1, 1, 2), Row(Backup, 32, 2, 1, 3)],
            new Dictionary<Guid, AgentHistoryJobState> { [Backup] = new(true, Day.AddHours(2)) }, AgentOrphanLabel.Unknown);
        check(running.Single(run => run.OutcomeId == "inProgress").Key == 31,
            "an In progress run is keyed by its first step row, so it keeps its key (and the grid its selection) as the running job writes more steps");
        var xpsOff = off.Single(run => run.Job == Backup && run.Key == 13);
        check(AgentHistoryReader.Passes(xpsOff, new(Outcome: "unknown"), null) && AgentHistoryReader.Passes(xpsOff, new(Outcome: "inProgress"), null) && !AgentHistoryReader.Passes(xpsOff, new(Outcome: "failed"), null),
            "the Unknown and In progress outcome filters keep the runs that read In progress or unknown with Agent XPs off");
        var args = new AgentHistoryLiveArgs(Outcome: "failed", Text: "FAILED", Step: 2);
        var nightly5 = runs.Single(run => run.Job == Nightly && run.Key == 5);
        check(AgentHistoryReader.Passes(nightly5, args, Day.AddHours(1)) && !AgentHistoryReader.Passes(nightly5, args, Day.AddHours(5))
            && !AgentHistoryReader.Passes(runs[0], args, null) && AgentHistoryReader.Passes(runs[0], new(Text: "SUCCEEDED"), null) && !AgentHistoryReader.Passes(runs[0], new(Step: 2), null),
            "the filters keep whole runs: started in the window, of the outcome, with any row's message containing the text (case-insensitive) and with a row of the step");
    }

    private static void Lint(Action<bool, string> check)
    {
        var writes = AgentSql.LintHistoryWrites().ToList();
        check(writes.Count == 6 && writes.All(item => item.Problems.Count == 0), "Delete History's batches pass their lint at 1, 2 and historyJobs jobs, all and older-than: "
            + string.Join("; ", writes.Where(item => item.Problems.Count > 0).Select(item => item.Name + ": " + string.Join(", ", item.Problems))));
        var all = AgentSql.HistoryDelete(2, older: false);
        var older = AgentSql.HistoryDelete(2, older: true);
        bool Refuses(string text) => AgentSql.LintHistoryDelete(text).Count > 0;
        check(Refuses(all.Replace("sp_purge_jobhistory @job_id = @job_id", "sp_purge_jobhistory", StringComparison.Ordinal))
            && Refuses(all.Replace("sp_purge_jobhistory", "sp_delete_job", StringComparison.Ordinal))
            && Refuses(all.Replace("= @job2;", "= @job1;", StringComparison.Ordinal))
            && Refuses(all.Replace("COMMIT TRANSACTION;", "DROP TABLE x;\nCOMMIT TRANSACTION;", StringComparison.Ordinal))
            && Refuses(all.Replace("@job_id = @job_id;", "@job_id = @job_id, @oldest_date = @oldest_date;", StringComparison.Ordinal))
            && Refuses(older.Replace(", @oldest_date = @oldest_date", "", StringComparison.Ordinal))
            && Refuses(all.Replace("THROW 50012", "THROW 50011", StringComparison.Ordinal))
            && Refuses(all.Replace(AgentSql.HistoryJobGoneMessage, "gone", StringComparison.Ordinal))
            && Refuses(all.Replace("BEGIN TRANSACTION;\n", "", StringComparison.Ordinal))
            && Refuses(AgentSql.HistoryAllHead + AgentSql.HistoryTail)
            && Refuses(AgentSql.HistoryAllHead + string.Concat(Enumerable.Range(1, (int)AgentCatalog.Current.Limit("historyJobs") + 1).Select(at => AgentSql.HistoryJobPart(at, false))) + AgentSql.HistoryTail),
            "Delete History's lint refuses a purge without @job_id (msdb would purge every job), another procedure, a job resolved twice, any other statement, a cut-off the batch never computed or one left out, other THROWs or messages, no transaction, no job and more than historyJobs jobs");
        check(older.Contains("DATEADD(", StringComparison.Ordinal) && older.IndexOf("sp_purge_jobhistory", StringComparison.Ordinal) > older.IndexOf("BEGIN TRANSACTION;", StringComparison.Ordinal)
            && AgentSql.HistoryDeleteParameters(2, true).Select(parameter => parameter.Name).SequenceEqual(["@job1", "@job2", "@count", "@unit", "@before"])
            && AgentSql.HistoryDeleteParameters(1, false).Select(parameter => parameter.Name).SequenceEqual(["@job1"])
            && AgentSql.Lint(AgentSql.HistoryAllSince, null).Count == 0 && AgentSql.Lint(AgentSql.HistoryMessage, null).Count == 0,
            "older-than computes its cut-off from the server's clock before the transaction, binds @job1..@jobN then @count, @unit and @before, and the history reads pass the Agent read lint");
    }

    private static void Validation(Action<bool, string> check)
    {
        var id = Nightly.ToString();
        var max = (int)AgentCatalog.Current.Limit("historyJobs");
        var many = Enumerable.Range(0, max + 1).Select(at => new Guid(at, 0, 0, new byte[8]).ToString()).ToList();
        check(ActionService.HistoryDeleteValid(new([id], All: true)) && ActionService.HistoryDeleteValid(new([id, Backup.ToString()], OlderThan: new(30, 1, "2026-11-15T02:30:00")))
            && !ActionService.HistoryDeleteValid(new([], All: true)) && !ActionService.HistoryDeleteValid(new(null, All: true)) && !ActionService.HistoryDeleteValid(new(many, All: true))
            && !ActionService.HistoryDeleteValid(new([id, id.ToUpperInvariant()], All: true)) && !ActionService.HistoryDeleteValid(new(["x"], All: true))
            && !ActionService.HistoryDeleteValid(new([id])) && !ActionService.HistoryDeleteValid(new([id], All: true, OlderThan: new(1, 1))) && !ActionService.HistoryDeleteValid(new([id], All: false))
            && !ActionService.HistoryDeleteValid(new([id], OlderThan: new(0, 1))) && !ActionService.HistoryDeleteValid(new([id], OlderThan: new(1, 4)))
            && !ActionService.HistoryDeleteValid(new([id], OlderThan: new(1, 1, "2026-11-15 02:30:00"))),
            "Delete History takes 1 to historyJobs distinct job ids and exactly one of all and older-than (Agent Properties' purge bounds), as main's schema does");
        var values = ActionService.HistoryDeleteValues(new([id, Backup.ToString()], OlderThan: new(2, 3, "2026-11-15T02:30:00")));
        check(values.Length == 5 && values[0] is Guid first && first == Nightly && values[1] is Guid second && second == Backup && values[2] is 2 && values[3] is 3 && values[4] is DateTime before && before == Day.AddHours(2).AddMinutes(30),
            "Delete History's values follow its parameters: the job ids, then the count, the unit and the confirmed cut-off");
    }

    private static object?[] JobRow(AgentStatement statement, Guid id, string name, int status) => [.. statement.Columns.Select(column => (object?)(column switch
    {
        "job_id" => id, "name" => name, "enabled" => (byte)1, "owner" => "sa", "current_execution_status" => status, _ => null
    }))];

    private static object?[] HistoryRow(AgentStatement statement, AgentHistoryRow row) => [.. statement.Columns.Select(column => (object?)(column switch
    {
        "instance_id" => row.Instance, "job_id" => row.Job, "step_id" => row.Step, "step_name" => row.StepName, "sql_message_id" => row.MessageId, "sql_severity" => row.Severity, "message" => row.Message,
        "run_status" => row.Status, "run_date" => row.Started is { } date ? date.Year * 10000 + date.Month * 100 + date.Day : 0,
        "run_time" => row.Started is { } time ? time.Hour * 10000 + time.Minute * 100 + time.Second : 0, "run_duration" => row.Duration, "retries_attempted" => row.Retries, _ => null
    }))];

    private static readonly List<AgentHistoryRow> History = [
        Row(Nightly, 1, 1, 1, 2), Row(Nightly, 2, 0, 1, 2), Row(Nightly, 3, 1, 1, 3), Row(Nightly, 4, 2, 0, 3, 1, "Violation of PRIMARY KEY constraint " + new string('x', 600)), Row(Nightly, 5, 0, 0, 3),
        Row(Backup, 10, 1, 1, 1), Row(Backup, 11, 0, 1, 1), Row(Backup, 12, 1, 1, 9)
    ];

    private static AgentReader Fake(List<string> ran, Func<AgentStatement, AgentResult?>? answer = null) => new()
    {
        TestRun = (statement, values, _) =>
        {
            ran.Add(statement.Id);
            if (answer?.Invoke(statement) is { } given) return Task.FromResult(given);
            var job = values.GetValueOrDefault("@job_id") as Guid?;
            List<object?[]> rows = statement.Id switch
            {
                "jobActivity" => [JobRow(statement, Nightly, "Nightly", 4), JobRow(statement, Backup, "Backup", 1)],
                "activities" => [[Backup, Day.AddHours(9), null]],
                "clock" => [[Day.AddHours(10)]],
                "properties" => [[1000, 100, null, null]],
                "history" or "historySince" or "historyAll" or "historyAllSince" => [.. History.Where(row => job is null || row.Job == job).OrderByDescending(row => row.Instance).Select(row => HistoryRow(statement, row))],
                _ => []
            };
            return Task.FromResult(new AgentResult(statement.Columns, rows, false));
        }
    };

    private static LiveDue Due() => new(new LiveProbeState(LiveCatalog.Current.Probes[AgentHistoryReader.ListProbe], 15000), null, null, null, null, new Dictionary<int, LiveTrackArgs>());
    private static string[] Texts(LiveRow row) => [.. row.Cells.Select(cell => cell.Text ?? "NULL")];

    private static async Task ReaderAsync(Action<bool, string> check)
    {
        var spec = LiveCatalog.Current.Probes[AgentHistoryReader.ListProbe];
        var ran = new List<string>();
        var reader = new AgentHistoryReader(new()) { Reader = Fake(ran), TestService = () => (1, 4) };
        var sample = await reader.ReadAsync(null!, LiveSql.UncommittedPrologue, Due(), null, CancellationToken.None);
        var runs = sample.Tables[0].Rows.Select(Texts).ToList();
        check(sample.Sampled && sample.Errors.Count == 0 && ran.SequenceEqual(["jobActivity", "activities", "clock", "properties", "historyAll"])
            && sample.Tables.Select(table => table.Rows.FirstOrDefault()?.Cells.Length ?? spec.Tables[table.Table].Columns.Count).SequenceEqual(spec.Tables.Select(table => table.Columns.Count)),
            "with every job and no window the probe reads sp_help_job, the running job's start and the clock, the history caps, then every job's history, building each table in the catalogue's column count: " + string.Join(", ", ran));
        check(runs.Select(row => row[1] + ":" + row[2] + ":" + row[6]).SequenceEqual(["Backup:In progress:" + Backup.ToString("D") + ":12", "Nightly:Failed:" + Nightly.ToString("D") + ":5", "Nightly:Succeeded:" + Nightly.ToString("D") + ":2", "Backup:Succeeded:" + Backup.ToString("D") + ":11"])
            && runs[0][8] == "running" && runs[1][8] == "error" && runs[3][8] == "NULL" && runs[1][4] == "2" && runs[0][3] == "NULL" && runs[1][3] == "00:00:05" && runs[0][5] == AgentHistoryReader.InProgressMessage,
            "the runs are newest first, keyed job:instance, with the outcome's label, tone and duration, their step count and message; a running job's newest steps are In progress: " + string.Join(" | ", runs.Select(row => string.Join(",", row))));
        check(sample.Tables[1].Rows.Count == 0 && sample.Tables[2].Rows.Select(row => row.Cells[1].Text).SequenceEqual(["Backup", "Nightly"]) && sample.Tables[2].Rows[0].Cells[3].Text == "Yes"
            && sample.Status?.Any(status => status.Id == "historyMaxRows" && Equals(status.Value, 1000L)) == true && sample.Status.Any(status => status.Id == "historyMaxRowsPerJob" && Equals(status.Value, 100L)),
            "with no run selected the steps table is empty; the jobs table lists every job by name with whether it runs; the status carries Agent's history caps");
        reader.Apply(new AgentHistoryLiveArgs(Outcome: "failed", Run: new(Nightly.ToString(), 5)));
        ran.Clear();
        var failed = await reader.ReadAsync(null!, LiveSql.UncommittedPrologue, Due(), null, CancellationToken.None);
        var steps = failed.Tables[1].Rows.Select(Texts).ToList();
        check(ran.Count == 0 && failed.Tables[0].Rows.Count == 1 && failed.Tables[0].Rows[0].Cells[6].Text!.EndsWith(":5", StringComparison.Ordinal)
            && steps.Select(row => row[0]).SequenceEqual(["0", "1", "2"]) && steps[0][1] == AgentHistoryReader.OutcomeStepName && steps[2][2] == "Failed" && steps[2][11] == "error"
            && steps[2][8].Length == (int)AgentCatalog.Current.Limit("gridMessageChars") && steps[2][8].EndsWith('…') && steps[2][9] == "4",
            "an outcome filter and a selected run regroup the last read without SQL; the steps table lists the run's outcome row first, then its steps, messages cut to gridMessageChars: "
            + string.Join(", ", ran) + " | " + string.Join(" | ", steps.Select(row => string.Join(",", row))));
        reader.Apply(new AgentHistoryLiveArgs([Nightly.ToString()], 7));
        ran.Clear();
        var one = await reader.ReadAsync(null!, LiveSql.UncommittedPrologue, Due(), null, CancellationToken.None);
        check(ran.SequenceEqual(["jobActivity", "clock", "historySince"]) && one.Tables[0].Rows.All(row => row.Cells[1].Text == "Nightly") && one.Tables[2].Rows.Count == 2,
            "one checked job with a window reads only that job's history from the window's start (and the clock, for the window), and still lists every job: " + string.Join(", ", ran));
        reader.Apply(new AgentHistoryLiveArgs([Nightly.ToString(), Backup.ToString()]));
        ran.Clear();
        var two = await reader.ReadAsync(null!, LiveSql.UncommittedPrologue, Due(), null, CancellationToken.None);
        check(ran.SequenceEqual(["jobActivity", "activities", "clock", "history", "history"]) && two.Tables[0].Rows.Count == 4 && two.Tables[0].More == 0,
            "two checked jobs read each job's history by its id, so other jobs' rows never use up the cap: " + string.Join(", ", ran));
        var full = new List<string>();
        // Nightly (the lower id) is read first and fills the cap with its own rows, so Backup is never read.
        var filling = Fake(full);
        var rowsCap = (int)AgentCatalog.Current.Limit("historyRows");
        var cappedJobs = new AgentHistoryReader(new([Nightly.ToString(), Backup.ToString()]))
        {
            Reader = new AgentReader
            {
                TestRun = (statement, values, cap) =>
                {
                    if (statement.Id != "history") return filling.TestRun!(statement, values, cap);
                    full.Add(statement.Id);
                    var job = (Guid)values["@job_id"]!;
                    return Task.FromResult(new AgentResult(statement.Columns, [.. Enumerable.Range(1, rowsCap).Select(index => HistoryRow(statement, new(index, job, 0, null, null, null, "Run " + index, 1, Day.AddMinutes(-index), 5, 0)))], false));
                }
            },
            TestService = () => (1, 4)
        };
        var stopped = await cappedJobs.ReadAsync(null!, LiveSql.UncommittedPrologue, Due(), null, CancellationToken.None);
        check(full.Count(id => id == "history") == 1 && stopped.Tables[0].More == 1 && stopped.Tables[0].Rows.Count == rowsCap
            && stopped.Status?.Any(status => status.Id == "historySkippedJobs" && Equals(status.Value, 1L)) == true,
            "once the checked jobs' rows reach historyRows the jobs not yet read are left out and the runs say they were cut: " + string.Join(", ", full));
        reader.Apply(new AgentHistoryLiveArgs([]));
        ran.Clear();
        var none = await reader.ReadAsync(null!, LiveSql.UncommittedPrologue, Due(), null, CancellationToken.None);
        // A multi-server job by @job_id: msdb answers its target servers (NULL instance and step), so its history comes from the every-job read.
        var msx = new List<string>();
        var msxReader = new AgentHistoryReader(new([Nightly.ToString()])) { Reader = Fake(msx, statement => statement.Id == "history"
            ? new(statement.Columns, [[null, Nightly, null, null, null, null, null, 1, 20261115, 20000, 5, null]], false) : null), TestService = () => (1, 4) };
        var msxSample = await msxReader.ReadAsync(null!, LiveSql.UncommittedPrologue, Due(), null, CancellationToken.None);
        check(msx.SequenceEqual(["jobActivity", "properties", "history", "historyAll"]) && msxSample.Tables[0].Rows.Count == 2 && msxSample.Tables[0].Rows.All(row => row.Cells[1].Text == "Nightly")
            && msxSample.Tables[0].Rows.All(row => !row.Cells[6].Text!.EndsWith(":0", StringComparison.Ordinal)),
            "a multi-server job's target-server rows by @job_id are dropped and its history read from every job's, keeping only its rows: " + string.Join(", ", msx));
        // sp_help_jobactivity's start keeps milliseconds; run_time is whole seconds, so the running job's first step must still be In progress.
        var ms = new AgentHistoryReader(new()) { Reader = Fake([], statement => statement.Id == "activities" ? new(statement.Columns, [[Backup, Day.AddHours(9).AddMilliseconds(437), null]], false) : null), TestService = () => (1, 4) };
        var msSample = await ms.ReadAsync(null!, LiveSql.UncommittedPrologue, Due(), null, CancellationToken.None);
        check(msSample.Tables[0].Rows.Count(row => row.Cells[1].Text == "Backup" && row.Cells[2].Text == AgentHistoryReader.InProgressLabel) == 1
            && msSample.Tables[0].Rows.All(row => row.Cells[2].Text != AgentHistoryReader.UnknownLabel || row.Cells[1].Text != "Backup" || !row.Cells[6].Text!.EndsWith(":12", StringComparison.Ordinal)),
            "a running job whose start has milliseconds keeps the step that started in the same second in its In progress run");
        check(ran.SequenceEqual(["jobActivity"]) && none.Tables[0].Rows.Count == 0 && none.Tables[2].Rows.Count == 2, "no checked job reads no history, only the jobs: " + string.Join(", ", ran));
        var offReader = new AgentHistoryReader(new([Backup.ToString()])) { Reader = Fake([], statement => statement.Id == "jobActivity" ? new(statement.Columns, [JobRow(statement, Backup, "Backup", 4)], false) : null), TestService = () => (0, 4) };
        var off = await offReader.ReadAsync(null!, LiveSql.UncommittedPrologue, Due(), null, CancellationToken.None);
        check(off.Tables[0].Rows.Select(row => row.Cells[2].Text).SequenceEqual([AgentHistoryReader.XpsOffLabel, "Succeeded"]),
            "with Agent XPs off (sp_help_job then reports every job idle) and the service not read as stopped, steps with no outcome row read In progress or unknown");
    }

    private static async Task FailuresAsync(Action<bool, string> check)
    {
        var denied = new AgentHistoryReader { Reader = Fake([], statement => statement.Id == "jobActivity" ? throw ConnectionFailureChecks.Sql(229, 5, 14, "server", "The EXECUTE permission was denied on the object 'sp_help_job'.") : null) };
        var sample = await denied.ReadAsync(null!, LiveSql.UncommittedPrologue, Due(), null, CancellationToken.None);
        check(!sample.Sampled && sample.Errors is [{ Code: "PERMISSION_DENIED" }] && !sample.Errors[0].Message.Contains("sp_", StringComparison.Ordinal),
            "a login msdb refuses sp_help_job fails the probe with PERMISSION_DENIED, naming no procedure");
        // agent.historyMessage below sysadmin: sysjobhistory refused, the job's history through msdb; a row past that read's cap is not "gone".
        using (var service = new ActionService(new ActionChecks.FakeHost()))
        {
            AgentReader Below(bool truncated) => Fake([], statement => statement.Id == "historyMessage" ? throw ConnectionFailureChecks.Sql(229, 5, 14, "server", "The SELECT permission was denied on the object 'sysjobhistory'.")
                : statement.Id == "history" ? new(statement.Columns, [.. History.Where(row => row.Job == Nightly).Select(row => HistoryRow(statement, row))], truncated) : null);
            var found = await service.ReadHistoryMessageAsync(Below(false), null, Nightly, 2, CancellationToken.None);
            var gone = await service.ReadHistoryMessageAsync(Below(false), null, Nightly, 999, CancellationToken.None);
            var beyond = await service.ReadHistoryMessageAsync(Below(true), null, Nightly, 999, CancellationToken.None);
            check(found is { Error: null, Message: not null } && gone.Error is { Code: "NOT_FOUND", Message: ActionService.HistoryMessageGone } && beyond.Error is { Code: "NOT_FOUND", Message: ActionService.HistoryMessageBeyond },
                "below sysadmin the message reads through the job's history; a row missing from a full read is gone, and one past a capped read says it is too old to read here");
        }
        var partial = new AgentHistoryReader { Reader = Fake([], statement => statement.Id == "historyAll" ? throw ConnectionFailureChecks.Sql(15281, 1, 16, "server", "SQL Server blocked access to procedure 'dbo.sp_help_jobhistory' of component 'Agent XPs'.") : null), TestService = () => (1, 4) };
        var some = await partial.ReadAsync(null!, LiveSql.UncommittedPrologue, Due(), null, CancellationToken.None);
        check(some.Sampled && some.Tables[0].Rows.Count == 0 && some.Tables[1].Rows.Count == 0 && some.Tables[2].Rows.Count == 2 && some.Errors is [{ Code: "AGENT_DISABLED", Tables: [0, 1] }],
            "a refused history read leaves the runs and steps empty with its error (naming those tables) and still lists the jobs");
        var capped = new AgentHistoryReader { Reader = Fake([], statement => statement.Id == "historyAll" ? new(statement.Columns, [.. History.Select(row => HistoryRow(statement, row))], true) : null), TestService = () => (1, 4) };
        var cut = await capped.ReadAsync(null!, LiveSql.UncommittedPrologue, Due(), null, CancellationToken.None);
        check(cut.Tables[0].More == 1, "a history read past historyRows marks the runs table truncated");
    }
}
