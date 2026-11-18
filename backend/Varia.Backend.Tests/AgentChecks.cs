using Varia.Backend.Agent;
using Varia.Backend.Explorer;
using Varia.Backend.Live;

namespace Varia.Backend.Tests;

/// <summary>Offline SQL Server Agent checks (AG-0a): the embedded catalogue, the read lint over every statement and caller
/// with every allowed procedure and master shape rendered and near misses refused, the scratch Agent names, and the reader
/// against a fake server (statements fail alone, 15281 is AGENT_DISABLED, caps truncate, only linted statements run).</summary>
internal static class AgentChecks
{
    public static async Task RunAsync(Action<bool, string> check)
    {
        Catalog(check);
        Statements(check);
        Shapes(check);
        NearMisses(check);
        Scratch(check);
        await SweepAsync(check);
        await ReaderAsync(check);
    }

    private static void Catalog(Action<bool, string> check)
    {
        var catalog = AgentCatalog.Current;
        check(AgentCatalog.Version == 1 && catalog.EngineEditions.SetEquals([1, 2, 3, 8]) && catalog.ReadProcedures.Count == 15 && catalog.MasterReadShapes.Count == 4
            && catalog.WriteProcedures["xp_servicecontrol"] == "master" && catalog.WriteProcedures["sp_start_job"] == "msdb" && !catalog.ReadProcedures.ContainsKey("sp_purge_jobhistory")
            && catalog.ReadProcedures["sp_help_jobhistory"].Arguments["@mode"].SetEquals(["N'FULL'"]) && catalog.ReadProcedures["sp_help_job"].Arguments["@job_id"].Count == 0
            && catalog.Limit("historyRows") == 10_000 && catalog.Limit("serviceWaitMs") == 60_000 && catalog.RunStatuses[4] == "In Progress" && catalog.ExecutionStatuses[3] == "Between retries"
            && catalog.LastRunOutcomes[5] == "Unknown",
            "the embedded Agent catalogue is version 1: Agent on editions 1, 2, 3 and 8, fifteen msdb read procedures (never sp_purge_jobhistory), four master shapes, the write list and the limits");
        check(catalog.Offers("serviceControl", "windows") && !catalog.Offers("serviceControl", "linux") && !catalog.Offers("alerts", "managedInstance") && catalog.Offers("proxies", "linux")
            && catalog.PlatformOf(3, false) == "windows" && catalog.PlatformOf(2, true) == "linux" && catalog.PlatformOf(8, false) == "managedInstance" && catalog.PlatformOf(4, false) is null
            && catalog.PlatformOf(5, false) is null && catalog.PlatformSubsystems["linux"].SetEquals(["TSQL", "Distribution", "Snapshot", "LogReader"]),
            "the platform gates read as the catalogue declares them: service control on Windows only, no alerts on Managed Instance, proxies on Linux, no Agent on Express or Azure SQL Database");
        var unknown = false;
        try { catalog.Limit("noSuchLimit"); }
        catch (InvalidOperationException) { unknown = true; }
        check(unknown, "an unknown Agent limit is a bug, never a default");
    }

    private static void Statements(Action<bool, string> check)
    {
        var failures = AgentSql.Lint().Where(item => item.Problems.Count > 0).Select(item => item.Name + ": " + string.Join(", ", item.Problems)).ToList();
        check(failures.Count == 0 && AgentSql.Lint().Count() == AgentSql.All.Count * AgentSql.Callers.Count,
            "every Agent read statement passes AgentSql.LintRead under every caller (live, live committed, listing, describe): " + string.Join(" | ", failures));
        check(AgentSql.All.Select(statement => statement.Id).Distinct(StringComparer.Ordinal).Count() == AgentSql.All.Count && AgentSql.All.All(AgentSql.Known)
            && !AgentSql.Known(AgentSql.Jobs with { Text = "EXEC msdb.dbo.sp_help_job;" }),
            "the Agent statements have unique ids, and the reader knows them by reference, not by text");
        // The caller's prologue is the one the text must start with: a describe carries none, a live probe its pool's.
        var jobs = AgentSql.Jobs.Text;
        check(AgentSql.LintRead(LiveSql.UncommittedPrologue + jobs, CatalogSql.Prologue).Contains("does not start with its caller's prologue")
            && AgentSql.LintRead(jobs, LiveSql.UncommittedPrologue).Contains("does not start with its caller's prologue")
            && AgentSql.LintRead(CatalogSql.Prologue + jobs, null).Contains("carries a prologue its caller runs as its own command")
            && AgentSql.LintRead(jobs, null).Count == 0 && AgentSql.LintRead(CatalogSql.Prologue + jobs, CatalogSql.Prologue).Count == 0,
            "LintRead takes each caller's prologue: a listing's text must start with Object Explorer's, a live probe's with its pool's, and a describe's with none");
        // Declarations: every parameter used and declared.
        check(AgentSql.Lint(AgentSql.Job with { Parameters = [] }, null).Contains("uses the undeclared @job_id")
            && AgentSql.Lint(AgentSql.Jobs with { Parameters = [new("@job_id", System.Data.SqlDbType.UniqueIdentifier)] }, null).Contains("declares the unused @job_id")
            && AgentSql.Lint(AgentSql.Jobs with { Columns = ["name", "name"] }, null).Contains("has no or duplicate column names")
            && AgentSql.Lint(AgentSql.Jobs with { Cap = "rows" }, null).Contains("is capped by an unknown limit"),
            "an Agent statement's lint catches an undeclared or unused parameter, duplicate columns and an unknown cap");
    }

    /// <summary>Every allowed shape renders and passes: each read procedure with no arguments and with every argument (as a
    /// parameter, then as each listed constant), and each master shape with parameters.</summary>
    private static void Shapes(Action<bool, string> check)
    {
        var catalog = AgentCatalog.Current;
        var failures = new List<string>();
        void Pass(string text)
        {
            var problems = AgentSql.LintRead(text, null);
            if (problems.Count > 0) failures.Add(text + ": " + string.Join(", ", problems));
        }
        foreach (var procedure in catalog.ReadProcedures.Values)
        {
            Pass("EXEC msdb.dbo." + procedure.Name + ";");
            if (procedure.Arguments.Count == 0) continue;
            Pass("EXEC msdb.dbo." + procedure.Name + " " + string.Join(", ", procedure.Arguments.Keys.Select(argument => argument + " = " + argument)) + ";");
            foreach (var (argument, constants) in procedure.Arguments)
                foreach (var constant in constants) Pass("EXEC msdb.dbo." + procedure.Name + " " + argument + " = " + constant + ";");
        }
        foreach (var shape in catalog.MasterReadShapes.Values) Pass((shape.StartsWith("EXEC @rc", StringComparison.Ordinal) ? "DECLARE @rc int;\n" : "") + shape.Replace("@p", "@value", StringComparison.Ordinal));
        check(failures.Count == 0, "LintRead admits every allowlisted msdb read procedure with named parameter and constant arguments, and every master shape: " + string.Join(" | ", failures));
    }

    private static void NearMisses(Action<bool, string> check)
    {
        string[] misses =
        [
            "EXECUTE msdb.dbo.sp_help_job;",
            "EXEC msdb..sp_help_job;",
            "EXEC [msdb].[dbo].[sp_help_job];",
            "EXEC sp_help_job;",
            "EXEC msdb.dbo.sp_help_job",
            "EXEC msdb.dbo.sp_help_job @job_id;",
            "EXEC msdb.dbo.sp_help_job @job_id=@job_id;",
            "EXEC msdb.dbo.sp_help_job @job_id = @job_id , @job_aspect = N'JOB';",
            "EXEC msdb.dbo.sp_help_job @job_aspect = N'STEPS';",
            "EXEC msdb.dbo.sp_help_job @job_aspect = 'JOB';",
            "EXEC msdb.dbo.sp_help_job @job_name = @name;",
            "EXEC msdb.dbo.sp_help_job @job_id = @a, @job_id = @b;",
            "EXEC msdb.dbo.sp_help_jobhistory @mode = N'SUMMARY';",
            "EXEC msdb.dbo.sp_purge_jobhistory @job_id = @job_id;",
            "EXEC msdb.dbo.sp_start_job @job_id = @job_id;",
            "EXEC msdb.dbo.sp_delete_job @job_id = @job_id;",
            "DECLARE @rc int;\nEXEC @rc = msdb.dbo.sp_help_job;",
            "EXEC msdb.dbo.sp_help_job;\nDROP TABLE t;",
            "EXEC msdb.dbo.sp_help_job; -- note",
            "EXEC (N'SELECT 1');",
            "EXEC msdb.dbo.sp_executesql @stmt = @stmt;",
            "EXEC master.dbo.xp_enumerrorlogs 1;",
            "EXEC master.dbo.xp_enumerrorlogs @type;",
            "EXEC master.dbo.xp_readerrorlog @log, 1, @a, @b, NULL, NULL, N'desc';",
            "EXEC master.dbo.xp_readerrorlog @log, 2, @a, @b, NULL, NULL, N'asc';",
            "EXEC master.dbo.xp_readerrorlog @log, 2, @a, @b, @start, NULL, N'desc';",
            "EXEC master.dbo.xp_readerrorlog @log, 2, N'x', @b, NULL, NULL, N'desc';",
            "EXEC master.dbo.sp_readmierrorlog @log, 1, @a, @b;",
            "DECLARE @rc int;\nEXEC @rc = master.dbo.xp_servicecontrol N'Start', N'SQLServerAgent';",
            "DECLARE @rc int;\nEXEC @rc = master.dbo.xp_servicecontrol N'Stop', N'SQLServerAgent';",
            "DECLARE @rc int;\nEXEC @rc = master.dbo.xp_servicecontrol @action, N'SQLServerAgent';",
            "DECLARE @rc int;\nEXEC @rc = master.dbo.xp_servicecontrol N'QueryState', N'MSSQLSERVER';",
            "EXEC master.dbo.xp_servicecontrol N'QueryState', N'SQLServerAgent';",
            "EXEC master.dbo.xp_cmdshell @command;",
            "SELECT j.name INTO t FROM msdb.dbo.sysjobs_view AS j;",
            "SELECT OBJECT_NAME(j.category_id) FROM msdb.dbo.sysjobs_view AS j;"
        ];
        var passed = misses.Where(text => AgentSql.LintRead(text, null).Count == 0).ToList();
        check(passed.Count == 0, "LintRead refuses near misses: EXECUTE, other spellings of msdb.dbo, positional or unnamed arguments, other spacing, unlisted constants or arguments, write procedures, "
            + "EXEC @rc on msdb, a second statement, comments, dynamic SQL, other master literals, Start and Stop, xp_cmdshell, SELECT INTO and metadata built-ins: passed " + string.Join(" | ", passed));
    }

    private static void Scratch(Action<bool, string> check)
    {
        const string run = "VariaScratch_20261118120000_0123abcd";
        check(ScratchDatabase.AgentKinds.SequenceEqual(["px", "cr", "job", "sch", "al", "op"])
            && ScratchDatabase.AgentKinds.All(kind => ScratchDatabase.AgentKindOf(run + "_" + kind) == kind)
            && new[] { run + "_job2", run + "_x_job", run + "_lnew", run, run + "_sch_", "x" + run + "_op", "VariaScratch_2026111812000_0123abcd_job", "VariaScratch_20261118120000_0123ABCD_job" }
                .All(name => ScratchDatabase.AgentKindOf(name) is null)
            && ScratchDatabase.IsScratchJob(run + "_job") && !ScratchDatabase.IsScratchJob(run + "_sch"),
            "scratch Agent objects are the run prefix plus one kind tag (_job, _sch, _op, _al, _px, _cr), swept proxies first and operators last, in the exact-pattern style; anything else is never swept");
        var now = new DateTime(2026, 11, 18, 20, 0, 0, DateTimeKind.Utc);
        check(ScratchDatabase.StaleAgentObject(run + "_op", now) && !ScratchDatabase.StaleAgentObject("VariaScratch_20261118150000_0123abcd_op", now)
            && !ScratchDatabase.StaleAgentObject(run + "_x", now) && !ScratchDatabase.StaleAgentObject("VariaScratch_20261399000000_0123abcd_op", now),
            "a scratch Agent object is stale once its prefix's UTC timestamp is more than 6 hours old, so kinds without a creation date are swept too");
    }

    /// <summary>The stale-scratch sweep's Agent part against a fake server: stale objects go in dependency order, by id where
    /// msdb deletes by id, while fresh ones, unmarked jobs and names that only look like a run's stay.</summary>
    private static async Task SweepAsync(Action<bool, string> check)
    {
        const string stale = "VariaScratch_20200101000000_0000000a", fresh = "VariaScratch_29990101000000_0000000b";
        string?[][] rows =
        [
            ["op", "7", stale + "_op", null], ["al", "3", stale + "_al", null], ["sch", "12", stale + "_sch", null],
            ["job", "0f8fad5b-d9cb-469f-a165-70867728950e", stale + "_job", ScratchDatabase.JobMarker], ["job", "1f8fad5b-d9cb-469f-a165-70867728950e", stale + "_job", "someone's job"],
            ["cr", "65536", stale + "_cr", null], ["px", "2", stale + "_px", null], ["px", "4", fresh + "_px", null], ["op", "9", stale + "_opx", null], ["sch", "x", stale + "_sch", null]
        ];
        var ran = new List<string>();
        Task<SqlRun> Run(string sql, string database)
        {
            if (sql == ScratchDatabase.StaleAgentSql) return Task.FromResult(new SqlRun("completed", null, [[.. rows]]));
            if (database == "msdb" && (sql.StartsWith("EXEC msdb.dbo.sp_delete_", StringComparison.Ordinal) || sql.StartsWith("DROP CREDENTIAL", StringComparison.Ordinal))) ran.Add(sql);
            return Task.FromResult(new SqlRun("completed", null, [[]]));
        }
        await ScratchDatabase.SweepAsync(Run, _ => { });
        check(ran.SequenceEqual([
                "EXEC msdb.dbo.sp_delete_proxy @proxy_id = 2;", "DROP CREDENTIAL [" + stale + "_cr];",
                "EXEC msdb.dbo.sp_delete_job @job_id = '0f8fad5b-d9cb-469f-a165-70867728950e', @delete_history = 1, @delete_unused_schedule = 1;",
                "EXEC msdb.dbo.sp_delete_schedule @schedule_id = 12, @force_delete = 1;", "EXEC msdb.dbo.sp_delete_alert @name = N'" + stale + "_al';",
                "EXEC msdb.dbo.sp_delete_operator @name = N'" + stale + "_op';"]),
            "the sweep drops stale scratch Agent objects proxies first, then credentials, marked jobs, schedules, alerts and operators, and leaves fresh ones, unmarked jobs, "
            + "names that only look like a run's and rows whose id does not parse: " + string.Join(" | ", ran));
    }

    private static async Task ReaderAsync(Action<bool, string> check)
    {
        var ran = new List<string>();
        var reader = new AgentReader
        {
            TestRun = (statement, values, cap) =>
            {
                ran.Add(statement.Id);
                return statement.Id switch
                {
                    "properties" => throw ConnectionFailureChecks.Sql(15281, 1, 16, "server", "SQL Server blocked access to procedure 'dbo.sp_get_sqlagent_properties' of component 'Agent XPs'."),
                    "errorLogs" => throw ConnectionFailureChecks.Sql(229, 5, 14, "server", "The EXECUTE permission was denied on the object 'xp_enumerrorlogs'."),
                    "subsystems" => throw ConnectionFailureChecks.Sql(2812, 62, 16, "server", "Could not find stored procedure."),
                    "history" => Task.FromResult(new AgentResult(statement.Columns, [.. Enumerable.Range(0, cap).Select(_ => new object?[statement.Columns.Count])], Truncated: true)),
                    _ => Task.FromResult(new AgentResult(statement.Columns, [[.. statement.Columns.Select(_ => (object?)values.Count)]], false))
                };
            }
        };
        object? Value(AgentStatement statement, AgentParameter parameter) => parameter.Name == "@job_id" ? Guid.Empty : null;
        var (results, errors) = await reader.ReadAsync(null, null, [AgentSql.Jobs, AgentSql.Properties, AgentSql.ErrorLogs, AgentSql.Subsystems, AgentSql.History, AgentSql.Job], Value, CancellationToken.None);
        check(ran.SequenceEqual(["jobs", "properties", "errorLogs", "subsystems", "history", "job"]) && results.Keys.Order(StringComparer.Ordinal).SequenceEqual(["history", "job", "jobs"])
            && errors.Select(error => error.Statement + " " + error.Code + " " + error.Number).SequenceEqual(["properties AGENT_DISABLED 15281", "errorLogs PERMISSION_DENIED 229", "subsystems NOT_SUPPORTED 2812"])
            && errors.All(error => !error.Message.Contains("xp_", StringComparison.Ordinal) && !error.Message.Contains("sp_", StringComparison.Ordinal))
            && results["history"].Truncated && results["history"].Rows.Count == 10_000 && results["job"].Rows[0][0] is 1,
            "the Agent reader runs each statement alone: Agent XPs off (15281) is AGENT_DISABLED, an EXECUTE refusal PERMISSION_DENIED and a missing procedure NOT_SUPPORTED, as values naming no object, "
            + "while the statements after them still run, with their parameters, and a history read caps at historyRows: " + string.Join(", ", errors.Select(error => error.Statement + " " + error.Code)));
        var lost = false;
        try
        {
            await new AgentReader { TestRun = (_, _, _) => throw ConnectionFailureChecks.Sql(10054, 1, 20, "server", "An existing connection was forcibly closed.") }
                .ReadAsync(null, null, [AgentSql.Jobs], Value, CancellationToken.None);
        }
        catch (Microsoft.Data.SqlClient.SqlException) { lost = true; }
        var unchecked_ = false;
        try { await reader.ReadAsync(null, null, [AgentSql.Jobs with { Id = "other" }], Value, CancellationToken.None); }
        catch (RequestException error) when (error.Code == "BACKEND_ERROR") { unchecked_ = true; }
        check(lost && unchecked_, "a lost connection is thrown for the caller to handle, and a statement that is not one of AgentSql.All never runs (BACKEND_ERROR)");
        check(AgentReader.Classify(AgentSql.Jobs, ConnectionFailureChecks.Sql(300, 297)).Code == "PERMISSION_DENIED"
            && AgentReader.Classify(AgentSql.Jobs, ConnectionFailureChecks.Sql(1222, 1, 16, "server", "Lock request time out period exceeded.")).Code == "BLOCKED"
            && AgentReader.Classify(AgentSql.Jobs, ConnectionFailureChecks.Sql(50000, 1, 16, "server", "other")).Code == "SQL_ERROR",
            "the reader keeps the live classification for everything else: 300 then 297 (server state on 2022 and later) is PERMISSION_DENIED, a lock wait BLOCKED, the rest SQL_ERROR");
    }
}
