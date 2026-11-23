using Varia.Backend.Actions;
using Varia.Backend.Agent;
using Varia.Backend.Live;

namespace Varia.Backend.Tests;

/// <summary>Offline checks of the Agent error logs in the Log File Viewer (AG-5b): agent.errorLog's args, Recycle's batch and lint, the error log
/// reads under the Agent read lint, AgentErrorLogReader against a fake server (merging, the window, the search argument, the cap, Managed
/// Instance's oldest-first reader, refusals as values), agent.errorLogs' list, and Recycle's validation and engine refusal.</summary>
internal static class AgentErrorLogChecks
{
    private static readonly DateTime Day = new(2026, 11, 22, 12, 0, 0);

    public static async Task RunAsync(Action<bool, string> check)
    {
        Args(check);
        Lint(check);
        await ReaderAsync(check);
        await ListAsync(check);
        await RecycleAsync(check);
    }

    private static void Args(Action<bool, string> check)
    {
        var catalog = AgentCatalog.Current;
        bool Refused(AgentErrorLogLiveArgs args)
        {
            try { AgentErrorLogArgs.Check(args, catalog); return false; }
            catch (RequestException error) when (error.Code == "INVALID_PARAMS") { return true; }
        }
        check(!Refused(new([0])) && !Refused(new([0, 1, 99], 7, "Login failed")) && !Refused(new([.. Enumerable.Range(0, 100)]))
            && Refused(new()) && Refused(new([])) && Refused(new([-1])) && Refused(new([100])) && Refused(new([1, 1])) && Refused(new([0], Days: 0)) && Refused(new([0], Days: 3651))
            && Refused(new([0], Text: "")) && Refused(new([0], Text: new string('x', (int)catalog.Limit("searchChars") + 1))),
            "agent.errorLog's args take 1 to 100 distinct archive numbers 0 to 99, a 1 to 3650 day window and a 1 to searchChars text, as main's schema does");
    }

    private static void Lint(Action<bool, string> check)
    {
        var recycle = AgentSql.LintRecycleWrites().ToList();
        check(recycle is [{ Problems.Count: 0 }] && AgentSql.LintWrites().Any(item => item.Name == "recycle error log"),
            "Recycle's batch passes its lint, which the Agent write lint (and so the object actions' lint) runs: " + string.Join(", ", recycle.SelectMany(item => item.Problems)));
        bool Refuses(string text) => AgentSql.LintRecycle(text).Count > 0;
        check(Refuses(AgentSql.Recycle.Replace("sp_cycle_agent_errorlog", "sp_cycle_errorlog", StringComparison.Ordinal))
            && Refuses(AgentSql.Recycle.Replace("sp_cycle_agent_errorlog;", "sp_cycle_agent_errorlog @x = @x;", StringComparison.Ordinal))
            && Refuses(AgentSql.Recycle.Replace("\nIF @@ERROR", "\nEXEC @rc = msdb.dbo.sp_cycle_agent_errorlog;\nIF @@ERROR", StringComparison.Ordinal))
            && Refuses(AgentSql.Recycle[..AgentSql.Recycle.IndexOf("\nIF @@ERROR", StringComparison.Ordinal)])
            && Refuses(AgentSql.Recycle + "\nEXEC master.dbo.xp_servicecontrol N'Stop', N'SQLServerAgent';")
            && Refuses(AgentSql.Recycle.Replace("msdb.dbo.", "master.dbo.", StringComparison.Ordinal)),
            "Recycle's lint refuses another procedure, an argument, a second call, a missing return-code check, any other statement and another database");
        string text;
        using (var stream = typeof(AgentCatalog).Assembly.GetManifestResourceStream("Varia.Backend.Agent.agent-catalog.json")!)
        using (var source = new StreamReader(stream)) text = source.ReadToEnd();
        const string Row = "{\"arguments\":[],\"database\":\"msdb\",\"lane\":\"AG-5b\",\"name\":\"sp_cycle_agent_errorlog\"}";
        AgentCatalog Edited(string replacement) { using var edited = new MemoryStream(System.Text.Encoding.UTF8.GetBytes(text.Replace(Row, replacement, StringComparison.Ordinal))); return AgentCatalog.Parse(edited); }
        check(text.Contains(Row, StringComparison.Ordinal)
            && AgentSql.LintRecycle(AgentSql.Recycle, Edited("{\"database\":\"msdb\",\"lane\":\"AG-5b\",\"name\":\"sp_cycle_agent_errorlog\"}")).Count > 0
            && AgentSql.LintRecycle(AgentSql.Recycle, Edited(Row.Replace("[]", "[\"@x\"]", StringComparison.Ordinal))).Count > 0,
            "Recycle's lint refuses sp_cycle_agent_errorlog when the catalogue does not list it as a write, or lists arguments for it");
        check(AgentSql.Lint(AgentSql.ErrorLog, LiveSql.UncommittedPrologue).Count == 0 && AgentSql.Lint(AgentSql.ErrorLogMi, LiveSql.UncommittedPrologue).Count == 0
            && AgentSql.Lint(AgentSql.ServerClock, LiveSql.UncommittedPrologue).Count == 0 && AgentSql.Lint(AgentSql.ErrorLogs, null).Count == 0
            && AgentSql.Known(AgentSql.ErrorLogMi)
            && AgentSql.Lint(AgentSql.ErrorLogMi with { Text = "EXEC master.dbo.sp_readmierrorlog @log, 1, @search1, @search2;" }, LiveSql.UncommittedPrologue).Count > 0
            && AgentSql.Lint(AgentSql.ErrorLogMi with { Text = "EXEC master.dbo.sp_readmierrorlog @log, 2, @search1, @search2, NULL, NULL, N'desc';" }, LiveSql.UncommittedPrologue).Count > 0,
            "the error log reads pass the Agent read lint (Managed Instance's in its own master shape), and its near misses (another log type, xp_readerrorlog's arguments) do not");
    }

    private static object?[] LogRow(int minutesAgo, int level, string text) => [Day.AddMinutes(-minutesAgo), level, text];

    /// <summary>A fake server: archive 0 holds three rows (newest first), archive 1 two, an error log the reader passes text to records it.</summary>
    private static AgentReader Fake(List<string> ran, List<object?> searches, Func<AgentStatement, int, AgentResult?>? answer = null, bool oldestFirst = false) => new()
    {
        TestRun = (statement, values, cap) =>
        {
            ran.Add(statement.Id + (values.TryGetValue("@log", out var log) ? ":" + log : ""));
            if (values.ContainsKey("@search1")) searches.Add(values["@search1"]);
            var archive = log is int number ? number : -1;
            if (answer?.Invoke(statement, archive) is { } given) return Task.FromResult(given);
            List<object?[]> rows = statement.Id switch
            {
                "clock" => [[Day]],
                "errorLog" or "errorLogMi" => archive switch
                {
                    0 => [LogRow(5, 1, "[298] SQLServer Error: 18456, Login failed.\r\n"), LogRow(60, 2, "[000] Request to stop job refused"), LogRow(3 * 24 * 60, 3, "[393] Waiting for SQL Server to recover databases...")],
                    1 => [LogRow(10 * 24 * 60, 3, "[100] Microsoft SQLServerAgent version 17"), LogRow(11 * 24 * 60, 1, "[364] The Messenger subsystem could not be loaded")],
                    _ => []
                },
                _ => []
            };
            if (oldestFirst) rows.Reverse();
            var truncated = rows.Count > cap;
            return Task.FromResult(new AgentResult(statement.Columns, truncated ? rows.Take(cap).ToList() : rows, truncated));
        }
    };

    private static LiveDue Due() => new(new LiveProbeState(LiveCatalog.Current.Probes[AgentErrorLogReader.ReadProbe], 30000), null, null, null, null, new Dictionary<int, LiveTrackArgs>());
    private static string[] Texts(LiveRow row) => [.. row.Cells.Select(cell => cell.Text ?? "NULL")];

    private static async Task ReaderAsync(Action<bool, string> check)
    {
        var spec = LiveCatalog.Current.Probes[AgentErrorLogReader.ReadProbe];
        var ran = new List<string>();
        var searches = new List<object?>();
        var reader = new AgentErrorLogReader(new([1, 0])) { Reader = Fake(ran, searches) };
        var sample = await reader.ReadAsync(null!, LiveSql.UncommittedPrologue, Due(), null, CancellationToken.None);
        var rows = sample.Tables[0].Rows.Select(Texts).ToList();
        check(sample.Sampled && sample.Errors.Count == 0 && ran.SequenceEqual(["errorLog:0", "errorLog:1"]) && searches.All(value => value is null) && sample.Tables[0].More == 0
            && rows.All(row => row.Length == spec.Tables[0].Columns.Count) && (sample.Status ?? []).Count == 0,
            "with no window the probe reads each checked log by archive number in archive order with no search text, building rows in the catalogue's column count: " + string.Join(", ", ran));
        check(rows.Select(row => row[1] + ":" + row[2] + ":" + row[4]).SequenceEqual(["Current:Error:0:1", "Current:Warning:0:2", "Current:Information:0:3", "Archive #1:Information:1:1", "Archive #1:Error:1:2"])
            && rows[0][6] == "error" && rows[1][6] == "warning" && rows[2][6] == "NULL" && rows[0][3] == "[298] SQLServer Error: 18456, Login failed." && rows[3][5] == "1",
            "the checked logs' rows merge newest first, each named by its log, typed and toned by its level, keyed archive:place, its message without its line break: "
            + string.Join(" | ", rows.Select(row => string.Join(",", row))));
        reader.Apply(new AgentErrorLogLiveArgs([0, 1], 2, "Login"));
        ran.Clear();
        searches.Clear();
        var windowed = await reader.ReadAsync(null!, LiveSql.UncommittedPrologue, Due(), null, CancellationToken.None);
        check(ran.SequenceEqual(["clock", "errorLog:0", "errorLog:1"]) && searches.SequenceEqual(new object?[] { "Login", "Login" })
            && windowed.Tables[0].Rows.Select(row => row.Cells[4].Text).SequenceEqual(["0:1", "0:2"]),
            "a window reads the server's clock first and keeps rows from its start; the message text goes to the log reader as its search argument");
        var cap = (int)AgentCatalog.Current.Limit("logRows");
        var many = Enumerable.Range(0, cap + 5).Select(at => LogRow(at, 3, "row " + at)).ToList();
        var full = new AgentErrorLogReader(new([0, 1])) { Reader = Fake([], [], (statement, archive) => statement.Id == "errorLog" && archive == 0 ? new(statement.Columns, many.Take(cap).ToList(), true) : null) };
        var cut = await full.ReadAsync(null!, LiveSql.UncommittedPrologue, Due(), null, CancellationToken.None);
        check(cut.Tables[0].More == 1 && cut.Tables[0].Rows.Count == cap && cut.Tables[0].Rows[0].Cells[3].Text == "row 0",
            "a log read past logRows marks the table cut, keeps the newest rows, and reads no later log once the cap is reached");
        var ranMi = new List<string>();
        var mi = new AgentErrorLogReader(new([0])) { Reader = Fake(ranMi, [], oldestFirst: true), ManagedInstance = true };
        var miSample = await mi.ReadAsync(null!, LiveSql.UncommittedPrologue, Due(), null, CancellationToken.None);
        check(ranMi.SequenceEqual(["errorLogMi:0"]) && miSample.Status is [{ Id: "errorLogOldestFirst" }] && miSample.Tables[0].Rows.Select(row => row.Cells[4].Text).SequenceEqual(["0:3", "0:2", "0:1"]),
            "on Managed Instance the probe reads through sp_readmierrorlog, says it reads oldest first, and still lists rows newest first");
        var denied = new AgentErrorLogReader(new([0])) { Reader = Fake([], [], (statement, _) => statement.Id == "errorLog" ? throw ConnectionFailureChecks.Sql(229, 5, 14, "server", "The EXECUTE permission was denied on the object 'xp_readerrorlog'.") : null) };
        var refused = await denied.ReadAsync(null!, LiveSql.UncommittedPrologue, Due(), null, CancellationToken.None);
        check(!refused.Sampled && refused.Errors is [{ Code: "PERMISSION_DENIED" }] && !refused.Errors[0].Message.Contains("xp_", StringComparison.Ordinal),
            "below sysadmin the read fails the probe with PERMISSION_DENIED, naming no procedure");
        check(AgentErrorLogReader.Message(new string('m', AgentErrorLogReader.MessageChars + 10)) is { Length: AgentErrorLogReader.MessageChars } longText && longText.EndsWith('…')
            && AgentErrorLogReader.Message("x\r\n") == "x" && AgentErrorLogReader.Message(null) is null,
            "a message keeps at most MessageChars characters, ending in an ellipsis when cut, without its line break");
    }

    private static async Task ListAsync(Action<bool, string> check)
    {
        using var service = new ActionService(new ActionChecks.FakeHost());
        AgentReader Listing(Func<AgentStatement, AgentResult> answer) => new() { TestRun = (statement, _, _) => Task.FromResult(answer(statement)) };
        var listed = await service.ReadErrorLogsAsync(Listing(statement => new(statement.Columns,
            [[2, new DateTime(2026, 10, 21, 21, 24, 0), 5222], [0, new DateTime(2026, 11, 22, 14, 31, 0), 15592], [1, new DateTime(2026, 11, 13, 7, 48, 0), 6174]], false)), null, CancellationToken.None);
        check(listed is { Archives: true, Error: null } && listed.Logs.Select(log => log.Archive + "@" + log.Date + "/" + log.Bytes).SequenceEqual(["0@2026-11-22T14:31:00/15592", "1@2026-11-13T07:48:00/6174", "2@2026-10-21T21:24:00/5222"]),
            "agent.errorLogs lists the logs in archive order, Current first, with their server-time dates and sizes");
        var linux = await service.ReadErrorLogsAsync(new AgentReader { TestRun = (_, _, _) => throw new AgentShapeException("NOT_SUPPORTED", AgentReader.MissingMessage) }, null, CancellationToken.None);
        check(linux is { Archives: false, Error: null, Logs: [{ Archive: 0, Date: null }] }, "where xp_enumerrorlogs returns no list (SQL Server on Linux) the current log is listed alone");
        var refused = await service.ReadErrorLogsAsync(new AgentReader { TestRun = (_, _, _) => throw ConnectionFailureChecks.Sql(229, 5, 14, "server", "The EXECUTE permission was denied on the object 'xp_enumerrorlogs'.") }, null, CancellationToken.None);
        check(refused is { Logs: [], Error.Code: "PERMISSION_DENIED" }, "below sysadmin agent.errorLogs answers PERMISSION_DENIED as a value");
    }

    private static async Task RecycleAsync(Action<bool, string> check)
    {
        using var service = new ActionService(new ActionChecks.FakeHost());
        var agent = new ObjectRefDto("agent");
        ActionArgs Args(ObjectRefDto target) => new(ActionService.RecycleErrorLogAction, Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), target);
        string Answer(ActionArgs args, bool script = false)
        {
            try { service.Validate(args, script); return "accepted"; }
            catch (RequestException error) { return error.Code; }
        }
        check(Answer(Args(agent)) == "accepted" && Answer(Args(agent), script: true) == "INVALID_PARAMS" && Answer(Args(new ObjectRefDto("agent", Name: "x"))) == "INVALID_PARAMS"
            && Answer(Args(new ObjectRefDto("agentErrorLog", Name: "0"))) == "INVALID_PARAMS" && Answer(Args(agent) with { NewName = "x" }) == "INVALID_PARAMS",
            "Recycle runs on the Agent node with nothing else, and has no script");
        using var managed = new ActionService(new ActionChecks.FakeHost(8));
        var result = await managed.ExecuteAsync(Args(agent), CancellationToken.None);
        check(result.Error is { Code: "NOT_SUPPORTED", Message: ActionService.RecycleManagedInstanceMessage } && result.Steps.Count == 0,
            "Managed Instance is refused Recycle before any connection opens");
    }
}
