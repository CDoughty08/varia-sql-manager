using System.Text.Json;
using Varia.Backend.Agent;
using Varia.Backend.Explorer;
using Varia.Backend.Live;
using Varia.Backend.Protocol;

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
        await ProfileAsync(check);
    }

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
        UnmappedMemberHandling = System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow
    };

    /// <summary>agent.profile (AG-0b): its batch passes Object Explorer's lint for every band with only its own literals, reads the
    /// 2022 server-state permissions only from band 16, and Agent XPs by configuration id; the method is a SQL Server-only read on
    /// the explorer lane that checks ids and members before the connection; a server with no Agent answers NOT_SUPPORTED without
    /// connecting, a failed connection is a value, and msdb refusing the login is a profile with no role.</summary>
    private static async Task ProfileAsync(Action<bool, string> check)
    {
        var failures = AgentProfileSql.Lint().Where(item => item.Problems.Count > 0).Select(item => item.Band + ": " + string.Join(", ", item.Problems)).ToList();
        var old = AgentProfileSql.Render(new SqlRender(15));
        var current = AgentProfileSql.Render(new SqlRender(16));
        check(failures.Count == 0 && AgentProfileSql.Lint().Count() == ExplorerCatalog.MaxBand - ExplorerCatalog.MinBand + 1
            && !old.Contains("SECURITY STATE", StringComparison.Ordinal) && !old.Contains("PERFORMANCE STATE", StringComparison.Ordinal)
            && current.Contains("N'VIEW SERVER SECURITY STATE'", StringComparison.Ordinal) && current.Contains("N'VIEW SERVER PERFORMANCE STATE'", StringComparison.Ordinal)
            && current.Contains("c.value_in_use) FROM sys.configurations AS c WHERE c.configuration_id = 16384", StringComparison.Ordinal) && !current.Contains("Agent XPs", StringComparison.Ordinal)
            && !System.Text.RegularExpressions.Regex.IsMatch(current, @"\bEXEC\b", System.Text.RegularExpressions.RegexOptions.IgnoreCase),
            "agent.profile's batch passes CatalogSql.Lint for every band with its own literals, reads the 2022 server-state permissions from band 16 only, and Agent XPs by id as value_in_use: " + string.Join(" | ", failures));
        check(CatalogSql.Lint(current + "SELECT N'x';", new SqlRender(16), false, false, AgentProfileSql.Literals).Contains("has the literal N'x'")
            && CatalogSql.Lint(current, new SqlRender(16), false, false).Any(problem => problem.StartsWith("has the literal N'sysadmin'", StringComparison.Ordinal)),
            "agent.profile's literals are an exact set: another literal is refused, and the set is the batch's own, not Object Explorer's");

        using (var sql = new SqlService())
        {
            async Task<string> Code(string body)
            {
                try { await sql.DispatchAsync("agent.profile", JsonDocument.Parse(body).RootElement, Json); return "ok"; }
                catch (RequestException error) { return error.Code; }
                catch (JsonException) { return "JSON"; }
            }
            var codes = new[]
            {
                await Code("{\"connectionId\":\"" + Guid.NewGuid() + "\",\"requestId\":\"" + Guid.NewGuid() + "\"}"),
                await Code("{\"connectionId\":\"x\",\"requestId\":\"" + Guid.NewGuid() + "\"}"),
                await Code("{\"connectionId\":\"" + Guid.NewGuid() + "\",\"requestId\":\"y\"}"),
                await Code("{\"connectionId\":\"" + Guid.NewGuid() + "\",\"requestId\":\"" + Guid.NewGuid() + "\",\"extra\":1}")
            };
            check(codes.SequenceEqual(["NOT_CONNECTED", "INVALID_PARAMS", "INVALID_PARAMS", "JSON"]) && SqlService.MethodNames.Contains("agent.profile") && sql.Methods.Contains("agent.profile")
                && sql.LaneOf("agent.profile") == RequestLane.Explorer && !sql.Sensitive("agent.profile") && !sql.AnswersStop("agent.profile")
                && Providers.Of("agent.profile").SequenceEqual([Providers.SqlServer]),
                "agent.profile is a SQL Server-only read on the explorer lane that checks its ids and members before the connection: " + string.Join(", ", codes));
        }

        AgentProfileArgs Args() => new(Guid.NewGuid().ToString(), Guid.NewGuid().ToString());
        foreach (var (edition, words) in new[] { (4, "SQL Server Express"), (5, "Azure SQL Database") })
        {
            var host = new ExplorerChecks.FakeHost(16, edition);
            using var service = new ExplorerService(host);
            var result = await service.AgentProfileAsync(Args(), CancellationToken.None);
            check(result is { Profile: null, Error: { Code: "NOT_SUPPORTED", Retryable: false } } && result.Error.Message.Contains(words, StringComparison.Ordinal) && host.Connections == 0,
                "agent.profile on " + words + " answers NOT_SUPPORTED without connecting: " + result.Error?.Message);
        }
        var unreachable = new ExplorerChecks.FakeHost();
        using (var service = new ExplorerService(unreachable))
        {
            var result = await service.AgentProfileAsync(Args(), CancellationToken.None);
            check(result is { Profile: null, Error: not null } && unreachable.Connections == 1 && service.RunningCount == 0,
                "agent.profile that cannot reach the server answers an error value, not an exception, and unregisters: " + result.Error?.Code);
        }
        check(AgentProfileSql.NoMsdb("windows", 3) is { MsdbAccess: false, Sysadmin: false, UserRole: false, ReaderRole: false, OperatorRole: false, AgentXps: null, DatabaseMailXps: null },
            "msdb refusing the login (916) is a profile with msdb access off, no role and the server options unread");
        var denied = new ExplorerError("PERMISSION_DENIED", "denied", false);
        var refusedOpen = new ExplorerError("NO_DB_ACCESS", "no default database", false);
        check(AgentProfileSql.Failed(new("NO_DB_ACCESS", "no msdb", false), true, "linux", 2) is { Error: null, Profile: { MsdbAccess: false, Platform: "linux", EngineEdition: 2 } }
            && AgentProfileSql.Failed(denied, true, "windows", 3) is { Profile: null } refused && refused.Error == denied
            && AgentProfileSql.Failed(refusedOpen, false, "windows", 3) is { Profile: null } unopened && unopened.Error == refusedOpen,
            "agent.profile answers msdb refusing the login (NO_DB_ACCESS once open) as a profile with no role, and any other failure, a refused open included, as the error itself");
        // msdb refusing the login once the pool connection is open (916 from the scope wrapper) is a profile with no role; the
        // server-scope read of its server facts follows, and failing too (1222 here) leaves that profile with nothing read.
        static Microsoft.Data.SqlClient.SqlException NoMsdb() => ConnectionFailureChecks.Sql(916, 1, 14, "server", "The server principal is not able to access the database \"msdb\" under the current security context.");
        var refusing = new ExplorerChecks.FakeHost { Opening = (_, _) => Task.CompletedTask };
        var scopes = new List<(string? Database, string Statement)>();
        using (var service = new ExplorerService(refusing, new ExplorerOptions { TestStatementFailure = (database, statement, _) =>
        {
            lock (scopes) scopes.Add((database, statement));
            return Task.FromResult(database == "msdb" ? NoMsdb() : ConnectionFailureChecks.Sql(1222, 1, 16, "server", "Lock request time out period exceeded."));
        } }))
        {
            var result = await service.AgentProfileAsync(Args(), CancellationToken.None);
            bool Batch(string text, bool msdb) => Enumerable.Range(ExplorerCatalog.MinBand, ExplorerCatalog.MaxBand - ExplorerCatalog.MinBand + 1)
                .Any(band => AgentProfileSql.Render(new SqlRender(band), msdb) == text);
            check(result is { Error: null, Profile: { MsdbAccess: false, Sysadmin: false, UserRole: false, ServerServices: false, AgentXps: null } } && service.RunningCount == 0
                && scopes is [("msdb", var first), (null, var second)] && Batch(first, true) && Batch(second, false),
                "agent.profile whose msdb refuses the login after the connection opened (916) runs the server-scope batch at server scope next, and with that failing too answers a profile with msdb access off and no role: "
                + result.Error?.Code + " " + result.Error?.Message + " scopes " + string.Join(",", scopes.Select(scope => scope.Database ?? "server")));
        }
        // The server-scope read gets what is left of the one budget, never a fresh one: msdb's 916 takes 2 s of a 4.5 s budget, so
        // the server-scope read is cancelled about 4.5 s after msdb's started, and a reset budget could not cancel it before 6.5 s.
        // The bound sits just under that, leaving loaded CI runners 1.7 s of scheduling delay; msdb's read keeps 2.5 s of the budget
        // spare so it always answers its 916. The times are taken inside the fake statements, so the call's own overhead does not count.
        var budgetWatch = System.Diagnostics.Stopwatch.StartNew();
        long msdbAt = -1, cancelledAt = -1;
        using (var service = new ExplorerService(refusing, new ExplorerOptions
        {
            AgentProfileBudget = TimeSpan.FromMilliseconds(4500),
            TestStatementFailure = async (database, _, token) =>
            {
                if (database == "msdb")
                {
                    msdbAt = budgetWatch.ElapsedMilliseconds;
                    await Task.Delay(TimeSpan.FromSeconds(2), token);
                    return NoMsdb();
                }
                try { await Task.Delay(TimeSpan.FromSeconds(10), token); }
                finally { cancelledAt = budgetWatch.ElapsedMilliseconds; }
                return NoMsdb();
            }
        }))
        {
            var result = await service.AgentProfileAsync(Args(), CancellationToken.None);
            check(result is { Error: null, Profile.MsdbAccess: false } && msdbAt >= 0 && cancelledAt - msdbAt is > 2000 and < 6200 && service.RunningCount == 0,
                "agent.profile whose server-scope read outlasts what is left of the one budget answers the no-role profile, not a TIMEOUT, without restarting the budget: "
                + result.Error?.Code + ", msdb's read started at " + msdbAt + " ms, the server-scope read cancelled at " + cancelledAt + " ms");
        }
        // A disconnect during the server-scope read cancels the request (CANCELLED), never a profile for a connection that is gone.
        var reached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using (var service = new ExplorerService(refusing, new ExplorerOptions
        {
            TestStatementFailure = async (database, _, token) =>
            {
                if (database == "msdb") return NoMsdb();
                reached.TrySetResult();
                await Task.Delay(TimeSpan.FromSeconds(10), token);
                return NoMsdb();
            }
        }))
        {
            var args = Args();
            var call = service.AgentProfileAsync(args, CancellationToken.None);
            await reached.Task.WaitAsync(TimeSpan.FromSeconds(10));
            service.Forget(args.ConnectionId);
            string? code = null;
            try { await call; } catch (RequestException error) { code = error.Code; }
            check(code == "CANCELLED" && service.RunningCount == 0,
                "agent.profile whose connection is disconnected during the server-scope read is CANCELLED, not a no-role profile: " + (code ?? "answered"));
        }
        // SqlClient's TdsParserStateObject.ExecuteFlush can throw InvalidOperationException ("Operation cancelled by user.")
        // when a disconnect cancels ExecuteReaderAsync mid-flush on Windows LPC; RunAsync maps it to cancellation.
        var flushReached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using (var service = new ExplorerService(refusing, new ExplorerOptions
        {
            TestStatementFailure = async (_, _, token) =>
            {
                flushReached.TrySetResult();
                try { await Task.Delay(TimeSpan.FromSeconds(10), token); }
                catch (OperationCanceledException) { throw new InvalidOperationException("Operation cancelled by user."); }
                return NoMsdb();
            }
        }))
        {
            var args = Args();
            var call = service.AgentProfileAsync(args, CancellationToken.None);
            await flushReached.Task.WaitAsync(TimeSpan.FromSeconds(10));
            service.Forget(args.ConnectionId);
            string? code = null;
            try { await call; } catch (RequestException error) { code = error.Code; }
            check(code == "CANCELLED" && service.RunningCount == 0,
                "agent.profile maps SqlClient's cancelled InvalidOperationException on disconnect to CANCELLED: " + (code ?? "answered"));
        }
        // A server-scope read whose connection the server refuses to open (18456) is that error, not "no role".
        var opens = 0;
        var disabled = new ExplorerChecks.FakeHost { Opening = (_, _) => Interlocked.Increment(ref opens) == 1 ? Task.CompletedTask
            : throw ConnectionFailureChecks.Sql(18456, 1, 14, "server", "Login failed for user.") };
        using (var service = new ExplorerService(disabled, new ExplorerOptions { TestStatementFailure = (_, _, _) => Task.FromResult(NoMsdb()) }))
        {
            var result = await service.AgentProfileAsync(Args(), CancellationToken.None);
            check(result is { Profile: null, Error: not null } && opens == 2 && service.RunningCount == 0,
                "agent.profile whose server-scope read cannot open its connection (18456) answers that error, not a no-role profile: " + result.Error?.Code + " opens " + opens);
        }
        check(new[] { 13, 16 }.All(band => AgentProfileSql.Render(new SqlRender(band), msdb: false) is var text && !text.Contains("msdb", StringComparison.OrdinalIgnoreCase)
                && !text.Contains("IS_ROLEMEMBER", StringComparison.Ordinal) && text.Contains("IsClustered", StringComparison.Ordinal) && text.Contains("16384", StringComparison.Ordinal)),
            "agent.profile's server-scope batch names nothing in msdb and still reads the server state, clustering and Agent XPs");
        // A pool connection the server refuses to open (4060: its database was dropped) is an error value, never "msdb refused the login".
        var dropped = new ExplorerChecks.FakeHost { Opening = (_, _) => throw ConnectionFailureChecks.Sql(4060, 1, 11, "server", "Cannot open database requested by the login.") };
        using (var service = new ExplorerService(dropped))
        {
            var result = await service.AgentProfileAsync(Args(), CancellationToken.None);
            check(result is { Profile: null, Error: not null } && service.RunningCount == 0,
                "agent.profile whose pool connection cannot open its database (4060) answers the error, not a no-role profile: " + result.Error?.Code + " " + (result.Profile is null ? "" : "profile"));
        }
        check(AgentProfileSql.NoRow is { Code: "SQL_ERROR", Retryable: true } && !AgentProfileSql.NoRow.Message.StartsWith("Msg ", StringComparison.Ordinal) && !AgentProfileSql.NoRow.Message.Contains("Refresh", StringComparison.Ordinal),
            "a capability read with no row is a retryable SQL_ERROR in words, not a message numbered Msg 0, and leaves Refresh to retry to the renderer");
    }

    private static void Catalog(Action<bool, string> check)
    {
        var catalog = AgentCatalog.Current;
        check(AgentCatalog.Version == 1 && catalog.EngineEditions.SetEquals([1, 2, 3, 8]) && catalog.ReadProcedures.Count == 16 && catalog.ReadProcedures.ContainsKey("sysmail_help_profile_sp") && catalog.MasterReadShapes.Count == 4
            && !catalog.WriteProcedures.ContainsKey("xp_servicecontrol") && catalog.WriteProcedures.Values.All(database => database == "msdb") && catalog.WriteProcedures["sp_start_job"] == "msdb" && !catalog.ReadProcedures.ContainsKey("sp_purge_jobhistory")
            && catalog.ReadProcedures["sp_help_jobhistory"].Arguments["@mode"].SetEquals(["N'FULL'"]) && catalog.ReadProcedures["sp_help_job"].Arguments["@job_id"].Count == 0
            && catalog.Limit("historyRows") == 10_000 && catalog.Limit("serviceWaitMs") == 60_000 && catalog.RunStatuses[4] == "In Progress" && catalog.ExecutionStatuses[3] == "Between retries"
            && catalog.LastRunOutcomes[5] == "Unknown",
            "the embedded Agent catalogue is version 1: Agent on editions 1, 2, 3 and 8, sixteen msdb read procedures (the job document's sysmail_help_profile_sp among them) (never sp_purge_jobhistory), four master shapes, the write list (msdb only: no xp_servicecontrol, AG-2) and the limits");
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
            "msdb.dbo.sp_start_job @job_id = @job_id;",
            "SELECT 1DELETE FROM msdb.dbo.sysjobhistory;",
            "SELECT 0x1INSERT dbo.t VALUES (1);",
            "SELECT 1SHUTDOWN;",
            "SELECT 1.DELETE FROM dbo.t;",
            "SELECT $1DELETE FROM dbo.t;",
            "SELECT 1e1EXEC msdb.dbo.sp_start_job @job_id = @job_id;",
            "SELECT 1e1EXEC master.dbo.xp_servicecontrol N'Stop', N'SQLServerAgent';",
            "SELECT 1e1EXEC (N'SELECT 42');",
            "SELECT 1; DISABLE TRIGGER ALL ON ALL SERVER;",
            "SELECT 1; ENABLE TRIGGER ALL ON DATABASE;",
            "SELECT 1; WRITETEXT dbo.t.c @p N'x';",
            "SELECT 1; RECEIVE * FROM dbo.q;",
            "SELECT 1; SEND ON CONVERSATION @h (N'x');",
            "SELECT 1; END CONVERSATION @h;",
            "SELECT NEXT VALUE FOR dbo.s;",
            "SELECT 1; CHECKPOINT;",
            "SELECT 1; SETUSER;",
            "SELECT 1; REVERT;",
            "SELECT 1; RAISERROR(N'x', 10, 1) WITH LOG;",
            "SELECT 1; SET IMPLICIT_TRANSACTIONS ON;",
            "SELECT 1; SET LOCK_TIMEOUT -1;",
            "SELECT 1 FROM sys.objects AS o; IF 1 = 1 PRINT N'x';",
            "msdb.dbo.sp_delete_job @job_id = @job_id;",
            "master.dbo.xp_servicecontrol N'Stop', N'SQLServerAgent';",
            "sp_help_job;",
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
        check(ScratchDatabase.AgentKinds.SequenceEqual(["job", "px", "cr", "sch", "al", "op"])
            && ScratchDatabase.AgentKinds.All(kind => ScratchDatabase.AgentKindOf(run + "_" + kind) == kind)
            && new[] { run + "_job2", run + "_x_job", run + "_lnew", run, run + "_sch_", "x" + run + "_op", "VariaScratch_2026111812000_0123abcd_job", "VariaScratch_20261118120000_0123ABCD_job" }
                .All(name => ScratchDatabase.AgentKindOf(name) is null)
            && ScratchDatabase.IsScratchJob(run + "_job") && !ScratchDatabase.IsScratchJob(run + "_sch"),
            "scratch Agent objects are the run prefix plus one kind tag (_job, _sch, _op, _al, _px, _cr), swept jobs first and operators last, in the exact-pattern style; anything else is never swept");
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
            ["cr", "65536", stale + "_cr", null], ["px", "2", stale + "_px", null], ["px", "4", fresh + "_px", null], ["op", "9", stale + "_opx", null], ["sch", "x", stale + "_sch", null],
            ["usr", "5", stale + "_lagu", null], ["usr", "6", fresh + "_lagu", null], ["usr", "8", "VariaScratch_user", null]
        ];
        var ran = new List<string>();
        Task<SqlRun> Run(string sql, string database)
        {
            if (sql == ScratchDatabase.StaleAgentSql) return Task.FromResult(new SqlRun("completed", null, [[.. rows]]));
            if (database == "msdb" && (sql.StartsWith("EXEC msdb.dbo.sp_delete_", StringComparison.Ordinal) || sql.StartsWith("DROP CREDENTIAL", StringComparison.Ordinal) || sql.StartsWith("DROP USER", StringComparison.Ordinal))) ran.Add(sql);
            return Task.FromResult(new SqlRun("completed", null, [[]]));
        }
        await ScratchDatabase.SweepAsync(Run, _ => { });
        check(ran.SequenceEqual([
                "EXEC msdb.dbo.sp_delete_job @job_id = '0f8fad5b-d9cb-469f-a165-70867728950e', @delete_history = 1, @delete_unused_schedule = 1;",
                "EXEC msdb.dbo.sp_delete_proxy @proxy_id = 2;", "DROP CREDENTIAL [" + stale + "_cr];",
                "EXEC msdb.dbo.sp_delete_schedule @schedule_id = 12, @force_delete = 1;", "EXEC msdb.dbo.sp_delete_alert @name = N'" + stale + "_al';",
                "EXEC msdb.dbo.sp_delete_operator @name = N'" + stale + "_op';", "DROP USER [" + stale + "_lagu];"]),
            "the sweep drops stale scratch Agent objects marked jobs first, then proxies, credentials, schedules, alerts and operators, then stale scratch logins' msdb users, and leaves fresh ones, unmarked jobs, "
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
        var tooLong = false;
        try { await reader.ReadAsync(null, null, [AgentSql.ErrorLog], (_, parameter) => parameter.Name == "@search1" ? new string('x', (int)AgentCatalog.Current.Limit("searchChars") + 1) : null, CancellationToken.None); }
        catch (RequestException error) when (error.Code == "INVALID_PARAMS") { tooLong = true; }
        var (fits, _) = await reader.ReadAsync(null, null, [AgentSql.ErrorLog], (_, parameter) => parameter.Name == "@search1" ? new string('x', (int)AgentCatalog.Current.Limit("searchChars")) : null, CancellationToken.None);
        check(tooLong && fits.ContainsKey("errorLog"), "an Agent read refuses a search text longer than its parameter (INVALID_PARAMS) rather than letting SqlClient cut it, and runs one that fits");
        var unknownPrologue = false;
        try { await reader.ReadAsync(null, "SET NOCOUNT ON;\n", [AgentSql.Jobs], Value, CancellationToken.None); }
        catch (RequestException error) when (error.Code == "BACKEND_ERROR") { unknownPrologue = true; }
        check(unknownPrologue, "an Agent read after a prologue that is not one of AgentSql.Callers' never runs (BACKEND_ERROR)");
        var (shaped, shapeErrors) = await new AgentReader
        {
            TestRun = (statement, _, _) => statement.Id switch
            {
                "errorLogs" => throw new AgentShapeException("NOT_SUPPORTED", AgentReader.MissingMessage),
                "errorLog" => throw new AgentShapeException("BACKEND_ERROR", "The Agent read errorLog returned the columns A without Text."),
                _ => Task.FromResult(new AgentResult(statement.Columns, [], false))
            }
        }.ReadAsync(null, null, [AgentSql.ErrorLogs, AgentSql.ErrorLog, AgentSql.Jobs], Value, CancellationToken.None);
        check(shaped.Keys.SequenceEqual(["jobs"]) && shapeErrors is [{ Statement: "errorLogs", Code: "NOT_SUPPORTED", Number: 0 }, { Statement: "errorLog", Code: "BACKEND_ERROR", Number: 0 }],
            "a read with no result set fails alone as NOT_SUPPORTED, one without a declared column as BACKEND_ERROR, and the statements after them still run");
        check(AgentReader.Classify(AgentSql.Jobs, ConnectionFailureChecks.Sql(300, 297)).Code == "PERMISSION_DENIED"
            && AgentReader.Classify(AgentSql.Jobs, ConnectionFailureChecks.Sql(1222, 1, 16, "server", "Lock request time out period exceeded.")).Code == "BLOCKED"
            && AgentReader.Classify(AgentSql.Jobs, ConnectionFailureChecks.Sql(14234, 1, 16, "server", "The specified '@owner_login_name' is invalid.")) is { Code: "SQL_ERROR", Number: 14234, Message: AgentReader.FailedMessage }
            && AgentReader.Classify(AgentSql.Job, ConnectionFailureChecks.Sql(14262, 1, 16, "server", "The specified @job_id ('x') does not exist.")) is { Code: "NOT_FOUND", Message: AgentReader.GoneMessage }
            && AgentReader.Classify(AgentSql.Jobs, ConnectionFailureChecks.Sql(916, 1, 14, "server", "The server principal \"p\" is not able to access the database \"msdb\".")) is { Code: "PERMISSION_DENIED", Message: AgentReader.RefusedMessage },
            "the reader keeps the live classification for everything else: 300 then 297 (server state on 2022 and later) is PERMISSION_DENIED, a lock wait BLOCKED, the rest SQL_ERROR with a fixed sentence (msdb's texts quote their arguments); a job gone since the listing (14262) is NOT_FOUND and no msdb access (916) PERMISSION_DENIED, neither quoting msdb's text");
    }
}
