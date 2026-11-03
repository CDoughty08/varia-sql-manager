using System.Text.Json;

namespace Varia.Backend.Tests;

/// <summary>Live checks of Object Explorer's Logins listing (PR D4a): every login's status and detail agree with the catalog views
/// (a disabled login is `disabled`, one denied CONNECT SQL is `noAccess`, the two never merged again), and with
/// VARIA_TEST_SQL_SCRATCH=1 the run's own scratch SQL login goes through each state, its password policy flags included, while
/// another session's open ALTER LOGIN transaction does not block the listing (it reads catalog views only, never
/// LOGINPROPERTY, under the explorer pool's READ UNCOMMITTED). Other runs' scratch logins come and go, so the walk of the
/// server's logins leaves them out; only this run's login is changed, and it is dropped in finally.</summary>
internal static class LoginListingLiveChecks
{
    private static string Bracket(string name) => "[" + name.Replace("]", "]]", StringComparison.Ordinal) + "]";
    private static string Literal(string value) => "N'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";

    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, JsonSerializerOptions json)
    {
        async Task<T> Call<T>(string method, object args) => (T)await service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, json), json);
        async Task<SqlRun> InSession(string session, string text)
        {
            var result = await Call<QueryResult>("query.execute", new QueryArgs(info.Id, session, "master", text, Guid.NewGuid().ToString(), 100_000, 60, StopOnError: true));
            return new(result.Status, result.Error?.Message, [.. result.ResultSets.Select(set => LiveResultChecks.RowsOf(service.Results, set))]);
        }
        async Task<SqlRun> Sql(string text, string database = "master")
        {
            var session = Guid.NewGuid().ToString();
            try { return await InSession(session, database == "master" ? text : "USE " + Bracket(database) + ";\n" + text); }
            finally { await Call<object>("query.session.close", new SessionArgs(session)); }
        }
        async Task<(List<ExplorerNode> Nodes, ExplorerError? Error)> Listing(ExplorerFilterDto? filter = null)
        {
            var nodes = new List<ExplorerNode>();
            string? cursor = null;
            do
            {
                var page = await Call<ExplorerChildrenResult>("explorer.children", new ExplorerChildrenArgs(info.Id, Guid.NewGuid().ToString(),
                    new NodeRefDto("folder", Owner: new ObjectRefDto("server"), Folder: "logins"), Cursor: cursor, Filter: filter));
                if (page.Error is not null) return (nodes, page.Error);
                nodes.AddRange(page.Nodes);
                cursor = page.Cursor;
            } while (cursor is not null);
            return (nodes, null);
        }
        var words = service.Actions.Catalog.Logins;

        // Every login the listing shows, against what the catalog views say of it. Another run's scratch login can appear or go
        // between the two reads, so those are left out. Like the listing, the baseline reads uncommitted rows, so another run's
        // open CREATE or ALTER LOGIN cannot hold it; a failed read is a failing check, not an exception that ends the run.
        var baseline = await Sql("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;\nSELECT p.name, p.type, CONVERT(int, p.is_disabled), CONVERT(int, CASE WHEN EXISTS (SELECT 1 FROM sys.server_permissions AS sp "
            + "WHERE sp.grantee_principal_id = p.principal_id AND sp.type = 'COSQ' AND sp.state = 'D') THEN 1 ELSE 0 END), CONVERT(int, ISNULL(l.is_policy_checked, 0)), "
            + "CONVERT(int, ISNULL(l.is_expiration_checked, 0)) FROM sys.server_principals AS p LEFT JOIN sys.sql_logins AS l ON l.principal_id = p.principal_id "
            + "WHERE p.type IN ('S', 'U', 'G', 'C', 'K', 'E', 'X') ORDER BY p.name;");
        check(baseline.Status == "completed" && baseline.Sets.Count == 1, "the Logins listing checks read the catalog views' logins: " + baseline.Status + " " + baseline.Error);
        if (baseline.Status != "completed" || baseline.Sets.Count != 1) return;
        var expected = baseline.Sets[0].Where(row => !ScratchDatabase.IsScratchName(row[0]!)).ToDictionary(row => row[0]!, StringComparer.Ordinal);
        var (all, allError) = await Listing();
        var wrong = all.Where(node => !ScratchDatabase.IsScratchName(node.Label)).Where(node => !expected.TryGetValue(node.Label, out var row)
                || node.Status != words.StatusOf(row[2] == "1", row[3] == "1") || node.ConnectDenied != (row[3] == "1" ? true : null)
                || node.Detail != words.Detail(row[1]!, row[2] == "1", row[3] == "1", row[4] == "1", row[5] == "1"))
            .Select(node => node.Label + " (" + node.Status + ", " + node.Detail + ")").ToList();
        check(allError is null && all.Count >= expected.Count && wrong.Count == 0 && all.Any(node => node.Subtype == "sa"),
            "Object Explorer lists each login's state and kind as the catalog views give them: disabled, denied permission to connect (noAccess), the password policy flags: "
            + string.Join(", ", wrong.Take(5)) + allError?.Message);

        if (Environment.GetEnvironmentVariable("VARIA_TEST_SQL_SCRATCH") != "1")
        {
            Console.WriteLine("Logins listing scratch checks skipped. Set VARIA_TEST_SQL_SCRATCH=1 to allow creating and dropping a uniquely named login on a disposable development server.");
            return;
        }
        await using var scratch = ScratchDatabase.Bare((text, database) => Sql(text, database));
        if (!await scratch.CreateLoginAsync())
        {
            Console.WriteLine("Logins listing scratch checks skipped: the server accepts Windows logins only.");
            return;
        }
        var login = scratch.Login!;
        var only = new ExplorerFilterDto(Name: new("equals", login));
        async Task<string> Row()
        {
            var (nodes, error) = await Listing(only);
            return error is not null ? "error " + error.Code : string.Join(" | ", nodes.Select(node => node.Subtype + ", " + (node.Status ?? "none") + (node.ConnectDenied == true ? " + connectDenied" : "") + ", " + node.Detail));
        }
        var states = new List<string> { await Row() };
        await Sql("ALTER LOGIN " + Bracket(login) + " DISABLE;");
        states.Add(await Row());
        await Sql("ALTER LOGIN " + Bracket(login) + " ENABLE;\nDENY CONNECT SQL TO " + Bracket(login) + ";");
        states.Add(await Row());
        await Sql("ALTER LOGIN " + Bracket(login) + " DISABLE;");
        states.Add(await Row());
        await Sql("ALTER LOGIN " + Bracket(login) + " ENABLE;\nGRANT CONNECT SQL TO " + Bracket(login) + ";\nALTER LOGIN " + Bracket(login) + " WITH CHECK_POLICY = ON, CHECK_EXPIRATION = ON;");
        states.Add(await Row());
        check(states.SequenceEqual([
                "sql, none, SQL Server authentication",
                "sql, disabled, SQL Server authentication · Disabled",
                "sql, noAccess + connectDenied, SQL Server authentication · Permission to connect denied",
                "sql, disabled + connectDenied, SQL Server authentication · Disabled · Permission to connect denied",
                "sql, none, SQL Server authentication · Password policy enforced · Password expiration enforced"]),
            "a scratch login's row says disabled, denied permission to connect (noAccess, connectDenied), both (disabled, connectDenied), and its password policy, each as the server changes it: " + string.Join(" / ", states));

        // P8: another session holds ALTER LOGIN … DISABLE in an open transaction. LOGINPROPERTY would wait for it; the listing's
        // catalog views answer under READ UNCOMMITTED. A blocked listing would answer BLOCKED after the pool's 5 s lock timeout,
        // so the check needs no clock.
        var holder = Guid.NewGuid().ToString();
        try
        {
            var held = await InSession(holder, "BEGIN TRANSACTION;\nALTER LOGIN " + Bracket(login) + " DISABLE;\nSELECT CONVERT(int, is_disabled) FROM sys.server_principals WHERE name = " + Literal(login) + ";");
            var watch = System.Diagnostics.Stopwatch.StartNew();
            var during = await Row();
            var seconds = watch.Elapsed.TotalSeconds;
            check(held.Scalar == "1" && during.StartsWith("sql, ", StringComparison.Ordinal),
                "the Logins listing reads catalog views only, so another session's open ALTER LOGIN transaction does not block it ("
                + during + ", " + seconds.ToString("0.0", System.Globalization.CultureInfo.InvariantCulture) + " s)");
        }
        finally
        {
            await InSession(holder, "IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;");
            await Call<object>("query.session.close", new SessionArgs(holder));
        }
    }
}
