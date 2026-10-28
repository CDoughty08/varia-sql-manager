using System.Data;
using System.Text.Json;
using Microsoft.Data.SqlClient;
using Varia.Backend.Activity;
using Varia.Backend.Explorer;
using Varia.Backend.Live;
using Varia.Backend.Protocol;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>A host for the session actions that reaches no SQL Server: its opens wait until cancelled (or refuse), and it
/// counts the connections asked of it, so a check can prove a request ran no SQL.</summary>
internal sealed class ActivityFixtureHost(string connectionId, ServerProfile profile, bool hang = true, bool pretendOpen = false, string[]? applicationNames = null) : IActivityHost, ILiveHost
{
    public int Connections;
    public bool IsConnected(string id) => id == connectionId;
    public ServerProfile? Profile(string id) => id == connectionId ? profile : null;
    public SqlConnection MonitorConnection(string id) { Interlocked.Increment(ref Connections); return new SqlConnection(); }
    public SqlConnection KillConnection(string id) { Interlocked.Increment(ref Connections); return new SqlConnection(); }
    /// <summary>Waits until cancelled; refuses the sign-in without <paramref name="hang"/>; or, with <paramref name="pretendOpen"/>,
    /// returns at once and leaves the connection closed, so the first command throws something other than a SqlException.</summary>
    public async Task OpenAsync(SqlConnection connection, CancellationToken token)
    {
        if (pretendOpen) return;
        if (!hang) throw new RequestException("AUTH_KERBEROS", "Run kinit to get a ticket.");
        await Task.Delay(Timeout.Infinite, token);
    }
    public IReadOnlyCollection<string> ApplicationNames() => applicationNames ?? ["Varia SQL Manager"];
    public bool TestHooks => false;
    public string? ServerOf(string id) => id == connectionId ? "server:FIXTURE" : null;
    public ResultStore Store { get; } = new(64L * 1024 * 1024, 32L * 1024 * 1024);
    public SqlConnection PoolConnection(string id, string? database, string suffix) => throw new RequestException("NOT_CONNECTED", "The fixture reaches no SQL Server.");
}

/// <summary>Offline checks of the Activity Monitor's session actions (activity.details and activity.kill): the catalogue's
/// sections and outcomes, the kill template and the lint that guards it, the outcome mapping, every bound re-checked before
/// any SQL, the kill gates, the budgets answered as values, and the lanes.</summary>
internal static class ActivityActionChecks
{
    private static readonly ActivityCatalog Catalog = ActivityCatalog.Current;
    private static readonly ActivityRender Render = new(17, "box");

    public static async Task RunAsync(Action<bool, string> check, JsonSerializerOptions json)
    {
        CatalogChecks(check);
        Template(check);
        Lint(check);
        Outcomes(check);
        await ValidationAsync(check, json);
        await BudgetsAsync(check);
    }

    private static void CatalogChecks(Action<bool, string> check)
    {
        var details = ActivitySql.Statements("activity.details", Render);
        var fed = details.SelectMany(statement => statement.Feeds).ToHashSet(StringComparer.Ordinal);
        check(Catalog.DetailsSections.SequenceEqual(["session", "statement", "batch", "inputBuffer", "waits", "transactions", "tempdb", "locks"])
            && Catalog.DetailsTexts.SetEquals(["statement", "batch", "inputBuffer"]) && fed.SetEquals(Catalog.DetailsSections) && details[0].Id == "identity" && details[1].Id == "session"
            && details.All(statement => statement.Batch.StartsWith(ActivitySql.Prologue, StringComparison.Ordinal)),
            "Details checks identity before its session joins, then one statement per section of the catalogue (texts feed both statement and batch), each with the live prologue");
        var identity = details[0];
        check(identity.Text.Contains("FROM sys.dm_exec_sessions AS s WHERE s.session_id = @session_id;", StringComparison.Ordinal)
            && !identity.Text.Contains("JOIN", StringComparison.OrdinalIgnoreCase) && !identity.Text.Contains("sys.dm_exec_connections", StringComparison.OrdinalIgnoreCase)
            && identity.Columns.SequenceEqual(["session_id", "same_session"]) && identity.Parameters.Select(parameter => parameter.Name).ToHashSet().SetEquals(["@session_id", "@login_time"]),
            "Details' visibility and identity preflight needs only sessions, so an invisible target requires no joined-DMV permissions");
        var sections = details.Skip(2).ToList();
        var unguarded = sections.Where(statement => !statement.Text.Contains(" AND " + ActivitySql.SameSession, StringComparison.Ordinal) && !statement.Text.Contains("WHERE " + ActivitySql.SameSession, StringComparison.Ordinal)
            || !statement.Parameters.Any(parameter => parameter.Name == "@login_time")).Select(statement => statement.Id).ToList();
        check(sections.Select(statement => statement.Id).SequenceEqual(["texts", "inputBuffer", "waits", "transactions", "tempdb", "locks"]) && unguarded.Count == 0
            && ActivitySql.SameSession == "EXISTS (SELECT 1 FROM sys.dm_exec_sessions AS g WHERE g.session_id = @session_id AND g.login_time = @login_time)",
            "every Details section after the session read filters on the session's login time too, so an id SQL Server reused meanwhile reads nothing: " + string.Join(", ", unguarded));
        check(Catalog.KillOutcomes.SequenceEqual(["killed", "ended", "changed", "own", "system", "varia", "denied", "failed"])
            && Enumerable.Range(-1, 8).Select(SessionActions.KillOutcome).All(Catalog.KillOutcomes.Contains)
            && Catalog.Limit("detailsBudgetMs") == 10_000 && Catalog.Limit("killBudgetMs") == 25_000 && Catalog.Limit("detailsPreviewChars") == 65_536 && Catalog.Limit("detailsChars") == 1_000_000
            && Catalog.Limit("killMessageChars") == 2_000 && Catalog.UnavailableMessage == "Activity Monitor isn't available for this kind of server.",
            "Kill's outcomes, the budgets inside main's 15 s and 30 s deadlines, and the text sizes come from the catalogue");
        var names = Catalog.PoolProgramNames("Varia SQL Manager");
        var long128 = Catalog.PoolProgramNames(new string('a', 120));
        check(names.Count == 6 && names.Contains("Varia SQL Manager - Object Explorer") && names.Contains("Varia SQL Manager - Activity Monitor")
            && names.Contains("Varia SQL Manager - Object Actions") && !names.Contains("Varia SQL Manager") && long128.All(name => name.Length == 128),
            "Kill refuses this backend's pool sessions by their program names (cut to 128 characters as SqlService names its pools), never its query tabs");
        // Every connection may set its own Application Name: Kill's @pools holds the pool names of all of them, not only the
        // requesting connection's, each between line feeds so CHARINDEX matches whole names only.
        var host = new ActivityFixtureHost(Guid.NewGuid().ToString(), new ServerProfile(17, null, 3, null, false, true, true, 16),
            applicationNames: ["Varia SQL Manager", "Reporting", new string('b', 120)]);
        var list = new SessionActions(host, new LiveService(host)).PoolList();
        var listed = list.Split('\n');
        check(list.StartsWith('\n') && list.EndsWith('\n') && listed.Length == 2 + 12 + Catalog.PoolProgramNames(new string('b', 120)).Distinct().Count() && listed.Distinct().Count() == listed.Length - 1 && listed[1..^1].All(name => name.Length is > 0 and <= 128)
            && listed.Contains("Varia SQL Manager - Object Explorer") && listed.Contains("Reporting - Object Explorer") && listed.Contains("Reporting - Activity Monitor")
            && listed.Contains("Reporting - Integration Services Actions") && Catalog.PoolProgramNames(new string('b', 120)).All(listed.Contains)
            && !listed.Contains("Varia SQL Manager") && !listed.Contains("Reporting"),
            "Kill's @pools lists the pool program names of every connection of this backend, whatever Application Name each set (cut to 128 characters), and no query tab: " + listed.Length);
    }

    private static void Template(Action<bool, string> check)
    {
        var kill = ActivitySql.Statements("activity.kill", Render).Single();
        var text = kill.Text;
        int At(string fragment) => text.IndexOf(fragment, StringComparison.Ordinal);
        // The checks run in order: own session, gone, system, a different session under the id, then this backend's pools.
        check(At("@session_id = @@SPID THEN 2") < At("WHERE s.session_id = @session_id) THEN 1") && At(") THEN 1") < At("s.is_user_process = 0) THEN 4")
            && At("THEN 4") < At("s.login_time = @login_time") && At("ISNULL(s.host_process_id, -1) = ISNULL(@host_process_id, -1)) THEN 3") < At("s.host_process_id = @backend_pid")
            && text.Contains("s.host_process_id = @backend_pid\n                 AND CHARINDEX(NCHAR(10) + s.program_name + NCHAR(10), @pools) > 0) THEN 5", StringComparison.Ordinal)
            && kill.Parameters.Single(parameter => parameter.Name == "@pools") is { Type: SqlDbType.NVarChar, Size: -1 }
            && text.EndsWith("SELECT @state AS state;\nIF @state = 0 EXEC (@kill_text);", StringComparison.Ordinal)
            && kill.Parameters.Single(parameter => parameter.Name == "@session_id").Type == SqlDbType.Int && kill.Parameters.Single(parameter => parameter.Name == "@login_time").Type == SqlDbType.DateTime
            && kill.Columns.SequenceEqual(["state"]) && ActivitySql.KillPrologue == "SET NOCOUNT ON; SET LOCK_TIMEOUT 10000;\n",
            "the kill batch checks own, ended, system, changed and Varia's pools before it runs KILL, and runs it only for state 0");
    }

    private static void Lint(Action<bool, string> check)
    {
        var render = Render;
        var details = ActivitySql.Statements("activity.details", render);
        var session = details.Single(statement => statement.Id == "session");
        var locks = details.Single(statement => statement.Id == "locks");
        var kill = ActivitySql.Statements("activity.kill", render).Single();
        check(details.Concat([kill]).All(statement => ActivitySql.Lint(statement, render).Count == 0) && locks.Text.Contains("sys.dm_tran_locks", StringComparison.Ordinal),
            "Details' and Kill's statements pass the lint, the locks DMV only in Details' on-demand locks statement");
        ActivityStatement With(ActivityStatement statement, string from, string to) =>
            statement.Text.Contains(from, StringComparison.Ordinal) ? statement with { Text = statement.Text.Replace(from, to, StringComparison.Ordinal) } : throw new InvalidOperationException("No " + from);
        var mutations = new (string Name, ActivityStatement Statement)[]
        {
            ("the locks DMV outside the locks statement", With(session, "FROM sys.dm_exec_sessions AS s", "FROM sys.dm_exec_sessions AS s CROSS JOIN sys.dm_tran_locks AS l")),
            ("the locks statement under another id", locks with { Id = "waits" }),
            ("the locks statement in a probe", locks with { Probe = "activity.sessions" }),
            ("dynamic SQL outside Kill", session with { Text = session.Text + "\nEXEC (@kill_text);", Parameters = [.. session.Parameters] }),
            ("KILL built from text", With(kill, "CONVERT(nvarchar(11), @session_id)", "@target") with { Parameters = [.. kill.Parameters, new("@target", SqlDbType.NVarChar, 11)] }),
            ("KILL from an nvarchar session id", kill with { Parameters = [.. kill.Parameters.Select(parameter => parameter.Name == "@session_id" ? parameter with { Type = SqlDbType.NVarChar, Size = 11 } : parameter)] }),
            ("a second EXEC", kill with { Text = kill.Text + "\nEXEC (@kill_text);" }),
            ("EXEC of anything else", With(kill, "EXEC (@kill_text)", "EXEC (@other)")),
            ("KILL text reassigned from a string parameter", With(kill, "SELECT @state AS state;", "SELECT @kill_text = N'KILL ' + @pools + N';';\nSELECT @state AS state;")),
            ("KILL text reassigned in a query", With(kill, "SELECT @state AS state;", "SELECT @kill_text = s.program_name FROM sys.dm_exec_sessions AS s WHERE s.session_id = @session_id ORDER BY s.session_id;\nSELECT @state AS state;")),
            ("an unlisted literal in Kill", With(kill, "N';'", "N'; SHUTDOWN;'")),
            ("a TOP over 20 in Details", With(details.Single(statement => statement.Id == "waits"), $"TOP ({Catalog.Limit("detailsWaits")})", "TOP (21)")),
            ("an unordered TOP in Details", With(details.Single(statement => statement.Id == "texts"), "\nORDER BY CASE WHEN r.blocking_session_id > 0 THEN 0 ELSE 1 END, r.request_id;", ";")),
            ("a metadata built-in in Details", With(session, "d.name AS database_name", "DB_NAME(s.database_id) AS database_name")),
            ("an unknown method", session with { Probe = "activity.plan" })
        };
        var missed = mutations.Where(mutation => ActivitySql.Lint(mutation.Statement, render).Count == 0).Select(mutation => mutation.Name).ToList();
        check(missed.Count == 0, "the lint catches every mutation of the session actions' SQL: " + string.Join(", ", missed));
    }

    private static void Outcomes(Action<bool, string> check)
    {
        var actions = new SessionActions(new ActivityFixtureHost(Guid.NewGuid().ToString(), new ServerProfile(17, null, 3, null, false, true, true, 16)),
            new LiveService(new FixtureHost([], new ResultStore(1 << 20, 1 << 19))));
        check(new[] { 0, 1, 2, 3, 4, 5, -1, 6 }.Select(SessionActions.KillOutcome).SequenceEqual(["killed", "ended", "own", "changed", "system", "varia", "failed", "failed"]),
            "the kill batch's states map to their outcomes, and an unknown state is a failure");
        var refused = new[] { 6102, 6104, 6106, 6107 }.Select(number => actions.KillFailure(69, number, "x")).ToList();
        var other = actions.KillFailure(69, 2812, new string('m', 3000));
        check(refused.Select(outcome => outcome.Outcome).SequenceEqual(["denied", "own", "ended", "system"]) && refused.All(outcome => outcome.Message is null && outcome.SessionId == 69)
            && other is { Outcome: "failed", Message.Length: 2000 } && other.Message.StartsWith("Msg 2812: mmm", StringComparison.Ordinal) && other.Message.EndsWith('…'),
            "SQL Server's refusals of KILL map to denied, own, ended and system; anything else fails with its message, cut to 2,000 characters");
    }

    private static async Task<string> Code(Func<Task> call)
    {
        try { await call(); return "ok"; }
        catch (RequestException error) { return error.Code; }
        catch (JsonException) { return "INVALID_PARAMS"; }
    }

    private static async Task ValidationAsync(Action<bool, string> check, JsonSerializerOptions json)
    {
        check(SessionActions.ParseLoginTime("2026-10-22T06:50:12") == new DateTime(2026, 10, 22, 6, 50, 12) && SessionActions.ParseLoginTime("2026-10-22T06:50:12.347") == new DateTime(2026, 10, 22, 6, 50, 12, 347)
            && SessionActions.ParseLoginTime("2026-10-22T06:50:12.3470000") == new DateTime(2026, 10, 22, 6, 50, 12, 347)
            && SessionActions.ParseLoginTime("1753-01-01T00:00:00") == new DateTime(1753, 1, 1) && SessionActions.ParseLoginTime("9999-12-31T23:59:59.997") == new DateTime(9999, 12, 31, 23, 59, 59, 997)
            && new[] { "9999-12-31T23:59:59.998", "9999-12-31T23:59:59.999", "9999-12-31T23:59:59.9999999", "2026-10-22 06:50:12", "2026-10-22T06:50:12Z", "2026-10-22T06:50:12+02:00", "2026-10-22T06:50:12.12345678", "2026-10-22T06:50", "1752-12-31T23:59:59", "2026-13-22T06:50:12",
                "2026-10-22T06:50:12\n", "", " 2026-10-22T06:50:12" }.All(value => SessionActions.ParseLoginTime(value) is null) && SessionActions.ParseLoginTime(null) is null
            && SessionActions.FormatLoginTime(new DateTime(2026, 10, 22, 6, 50, 12, 347)) == "2026-10-22T06:50:12.347",
            "a login time is server local time to at most 7 fractional digits, without an offset, within datetime's range (1753 to 9999-12-31T23:59:59.997), and Details answers it in the same form");
        var id = Guid.NewGuid().ToString();
        var host = new ActivityFixtureHost(id, new ServerProfile(17, null, 3, null, false, true, true, 16));
        var actions = new SessionActions(host, new LiveService(host));
        var request = Guid.NewGuid().ToString();
        var good = new ActivityDetailsArgs(Guid.NewGuid().ToString(), request, 69, "2026-10-22T06:50:12.347");
        var badDetails = new[]
        {
            good with { ConnectionId = "x" }, good with { RequestId = "" }, good with { SessionId = 0 }, good with { SessionId = 32_768 }, good with { LoginTime = "2026-10-22 06:50:12" },
            good with { LoginTime = new string('1', 41) }, good with { LoginTime = null! }, good with { Text = "plan" }, good with { Text = "batch", Locks = true },
            good with { LoginTime = "9999-12-31T23:59:59.999" }
        };
        var answers = new List<string>();
        foreach (var args in badDetails) answers.Add(await Code(() => actions.DetailsAsync(args, CancellationToken.None)));
        var notConnected = await Code(() => actions.DetailsAsync(good with { Text = "inputBuffer" }, CancellationToken.None));
        var killGood = new ActivityKillArgs(Guid.NewGuid().ToString(), [new(69, "2026-10-22T06:50:12.347", 4242), new(70, "2026-10-22T06:50:13", null)]);
        var badKills = new[]
        {
            killGood with { ConnectionId = "x" }, killGood with { Sessions = [] }, killGood with { Sessions = null! }, killGood with { Sessions = [.. Enumerable.Range(1, 65).Select(index => new ActivityKillSessionDto(index, "2026-10-22T06:50:12", null))] },
            killGood with { Sessions = [new(69, "2026-10-22T06:50:12", null), new(69, "2026-10-22T06:50:13", null)] }, killGood with { Sessions = [null] },
            killGood with { Sessions = [new(0, "2026-10-22T06:50:12", null)] }, killGood with { Sessions = [new(69, "yesterday", null)] },
            // Past datetime's range SqlClient throws an OverflowException after the sessions before it were killed.
            killGood with { Sessions = [new(69, "2026-10-22T06:50:12", null), new(70, "9999-12-31T23:59:59.999", null)] }
        };
        foreach (var args in badKills) answers.Add(await Code(() => actions.KillAsync(args, CancellationToken.None)));
        var killNotConnected = await Code(() => actions.KillAsync(killGood with { Sessions = [.. Enumerable.Range(1, 64).Select(index => new ActivityKillSessionDto(index, "2026-10-22T06:50:12", null))] }, CancellationToken.None));
        check(answers.All(answer => answer == "INVALID_PARAMS") && notConnected == "NOT_CONNECTED" && killNotConnected == "NOT_CONNECTED" && host.Connections == 0,
            "Details and Kill re-check every bound main's schema checks (ids, session ids 1 to 32,767, the login time, the text, locks without a text, 1 to 64 distinct sessions) before any connection: "
            + string.Join(", ", answers) + "; " + notConnected + ", " + killNotConnected);
        // An unknown member is refused by the wire's JSON options (the backend's Program.cs), as for every method.
        using var service = new SqlService();
        var wire = new JsonSerializerOptions(json) { UnmappedMemberHandling = System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow };
        var extra = JsonSerializer.SerializeToElement(new { connectionId = id, requestId = request, sessionId = 69, loginTime = "2026-10-22T06:50:12", extra = 1 }, wire);
        var refused = await Code(() => service.DispatchAsync("activity.details", extra, wire));
        check(refused == "INVALID_PARAMS" && service.LaneOf("activity.details") == RequestLane.Live && service.LaneOf("activity.kill") == RequestLane.Actions
            && SqlService.MethodNames.Contains("activity.details") && SqlService.MethodNames.Contains("activity.kill"),
            "Details runs on lane live (the live gates) and Kill on lane actions (no metadata slot); both are in HELLO and refuse unknown members");
        // A server the monitor does not serve: a value, and no connection.
        var azureId = Guid.NewGuid().ToString();
        var azure = new ActivityFixtureHost(azureId, new ServerProfile(12, null, 5, null, false, true, true, 16));
        var azureActions = new SessionActions(azure, new LiveService(azure));
        var azureDetails = await azureActions.DetailsAsync(good with { ConnectionId = azureId }, CancellationToken.None);
        var azureKill = await azureActions.KillAsync(killGood with { ConnectionId = azureId }, CancellationToken.None);
        check(azureDetails is { State: "unknown", Error.Code: "NOT_SUPPORTED", Error.Retryable: false } && azureKill is { Results.Count: 0, Error.Code: "NOT_SUPPORTED" } && azure.Connections == 0
            && azureKill.Error.Message == Catalog.UnavailableMessage,
            "on a server the monitor does not serve yet (Azure SQL Database), Details and Kill answer NOT_SUPPORTED as values without connecting");
    }

    private static async Task BudgetsAsync(Action<bool, string> check)
    {
        var id = Guid.NewGuid().ToString();
        var host = new ActivityFixtureHost(id, new ServerProfile(17, null, 3, null, false, true, true, 16));
        var live = new LiveService(host);
        var actions = new SessionActions(host, live) { DetailsBudgetMs = 300, KillBudgetMs = 300, GateWaitMs = 100 };
        var started = Environment.TickCount64;
        var details = await actions.DetailsAsync(new ActivityDetailsArgs(id, Guid.NewGuid().ToString(), 69, "2026-10-22T06:50:12"), CancellationToken.None);
        var detailsMs = Environment.TickCount64 - started;
        check(details is { State: "unknown", Error: { Code: "TIMEOUT", Retryable: true } } && details.Error.Message == "Reading the session took longer than 1 second. Refresh to try again."
            && detailsMs < 5_000 && live.Gates.Busy == 0,
            $"a Details read past its budget (a server that never answers) is a TIMEOUT value, and its live gate is back ({detailsMs} ms)");
        // A kill holds its connection's gate; a second kill on the same connection is BUSY rather than queueing behind it.
        using var stop = new CancellationTokenSource();
        var holding = actions.KillAsync(new ActivityKillArgs(id, [new(69, "2026-10-22T06:50:12", null)]), stop.Token);
        await Task.Delay(50);
        string? busyMessage = null;
        try { await actions.KillAsync(new ActivityKillArgs(id, [new(70, "2026-10-22T06:50:12", null)]), CancellationToken.None); }
        catch (RequestException error) when (error.Code == "BUSY") { busyMessage = error.Message; }
        var held = await holding;
        // The kill gates are one per connection and two in the backend: the message names the window, not the server.
        check(busyMessage == SessionActions.KillBusy && busyMessage == "Other Kill Process requests are running in this window. Retry when they finish."
            && held is { Results.Count: 0, Error: { Code: "TIMEOUT", Retryable: true } },
            "a second Kill on a connection whose Kill is still running is BUSY (worded for the window's kill gates), and a Kill past its budget is a TIMEOUT value that tried no session: "
            + busyMessage + ", " + held.Error?.Code);

        // Details waits for a live gate as long as its budget allows (C-critic G12), not Kill's fixed gate wait.
        var gates = new List<IDisposable>();
        for (var index = 0; index < LiveCatalog.Current.Limits.StatementsPerConnection; index++) gates.Add((await live.Gates.WaitAsync(id, 0, CancellationToken.None))!);
        var patient = new SessionActions(host, live) { DetailsBudgetMs = 2_000, GateWaitMs = 100 };
        started = Environment.TickCount64;
        var waiting = patient.DetailsAsync(new ActivityDetailsArgs(id, Guid.NewGuid().ToString(), 69, "2026-10-22T06:50:12"), CancellationToken.None);
        await Task.Delay(600);
        foreach (var gate in gates) gate.Dispose();
        gates.Clear();
        ActivityDetailsResult? afterWait = null;
        string? waitCode = null;
        try { afterWait = await waiting; } catch (RequestException error) { waitCode = error.Code; }
        var waitedMs = Environment.TickCount64 - started;
        check(waitCode is null && afterWait is { State: "unknown", Error.Code: "TIMEOUT" } && waitedMs >= 1_500 && live.Gates.Busy == 0,
            $"Details waits past Kill's gate wait for a live gate freed within its budget, then reads (here until its budget ends): {waitCode ?? afterWait?.Error?.Code} after {waitedMs} ms");
        for (var index = 0; index < LiveCatalog.Current.Limits.StatementsPerConnection; index++) gates.Add((await live.Gates.WaitAsync(id, 0, CancellationToken.None))!);
        var full = new SessionActions(host, live) { DetailsBudgetMs = 300 };
        string? fullCode = null, fullMessage = null;
        started = Environment.TickCount64;
        try { await full.DetailsAsync(new ActivityDetailsArgs(id, Guid.NewGuid().ToString(), 69, "2026-10-22T06:50:12"), CancellationToken.None); }
        catch (RequestException error) { (fullCode, fullMessage) = (error.Code, error.Message); }
        var fullMs = Environment.TickCount64 - started;
        foreach (var gate in gates) gate.Dispose();
        check(fullCode == "BUSY" && fullMessage == SessionActions.DetailsBusy && fullMs < 4_000 && live.Gates.Busy == 0,
            $"Details whose whole budget goes waiting for a live gate answers BUSY, not TIMEOUT: {fullCode} after {fullMs} ms");

        // Something other than a SqlException in one session's batch still answers the outcomes gathered, as values.
        var closed = new ActivityFixtureHost(id, new ServerProfile(17, null, 3, null, false, true, true, 16), pretendOpen: true);
        var odd = await new SessionActions(closed, new LiveService(closed)).KillAsync(new ActivityKillArgs(id, [new(69, "2026-10-22T06:50:12", null), new(70, "2026-10-22T06:50:12", null)]), CancellationToken.None);
        check(odd is { Results: [{ SessionId: 69, Outcome: "failed" }], Error.Code: "CONNECTION_LOST" } && odd.Results[0].Message == ActivityErrors.KillFailed,
            "a Kill whose batch throws something other than a SqlException answers that session failed (outcome unknown) and stops on a closed connection, as values: "
            + string.Join(", ", odd.Results.Select(result => result.Outcome)) + " " + odd.Error?.Code);
        var refusing = new ActivityFixtureHost(id, new ServerProfile(17, null, 3, null, false, true, true, 16), hang: false);
        var signIn = await new SessionActions(refusing, new LiveService(refusing)).KillAsync(new ActivityKillArgs(id, [new(69, "2026-10-22T06:50:12", null)]), CancellationToken.None);
        check(signIn is { Results.Count: 0, Error: { Code: "AUTH_KERBEROS", Message: "Run kinit to get a ticket." } }, "a Kill whose sign-in fails says what to fix, as a value, and tried nothing");
        actions.Forget(id);
    }
}
