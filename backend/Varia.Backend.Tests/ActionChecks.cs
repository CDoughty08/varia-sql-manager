using System.Text.Json;
using Microsoft.Data.SqlClient;
using Varia.Backend.Actions;
using Varia.Backend.Explorer;
using Varia.Backend.Protocol;

namespace Varia.Backend.Tests;

/// <summary>Offline object action checks: the embedded catalogue, the lint over every statement and band, the script text
/// of hostile names, plans, validation parity with zod, lanes, error classification, and the service with a fake host.</summary>
internal static class ActionChecks
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
        UnmappedMemberHandling = System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow
    };
    private static readonly ActionsCatalog Catalog = ActionsCatalog.Current;
    private static readonly ServerProfile Box2022 = new(16, "16.0.4135.4", 3, "sa", false, true, false, 16);
    private static readonly string NL = Environment.NewLine;

    /// <summary>A name at the sysname limit made of an injection fragment.</summary>
    public static string Long(string fragment) => (fragment + new string('x', 128))[..128];

    public static async Task RunAsync(Action<bool, string> check)
    {
        CatalogChecks(check);
        Lint(check);
        ScriptText(check);
        Plans(check);
        Errors(check);
        Validation(check);
        await ServiceAsync(check);
    }

    private static void CatalogChecks(Action<bool, string> check)
    {
        var rows = Catalog.Rows.ToList();
        check(rows.Count == 32 && rows.All(row => ExplorerCatalog.Current.Kind(row.Kind) is { } kind && (row.Subtype == "" || kind.Subtypes.Contains(row.Subtype))),
            "the embedded actions catalogue loads at version 2 and every row names an Object Explorer kind and subtype");
        check(Catalog.Allows("table", "", "delete") && Catalog.Allows("table", "graphEdge", "rename") && !Catalog.Allows("table", "system", "rename") && !Catalog.Allows("table", "systemVersioned", "delete")
            && !Catalog.Allows("procedure", "extended", "delete") && !Catalog.Allows("database", "system", "rename") && Catalog.Allows("database", "snapshot", "delete")
            && !Catalog.Allows("database", "snapshot", "rename") && Catalog.Allows("function", "aggregate", "rename") && !Catalog.Allows("function", "aggregate", "delete")
            && !Catalog.Offered("login", "delete") && Catalog.Offered("view", "selectTop"), "the catalogue's rows decide what each subtype allows");
        var options = new ActionServiceOptions();
        check(Catalog.Limit("readPerConnection") == options.ReadPerConnection && Catalog.Limit("readTotal") == options.ReadTotal && Catalog.Limit("executePerConnection") == options.ExecutePerConnection
            && Catalog.Limit("executeTotal") == options.ExecuteTotal && Catalog.Limit("registered") == options.MaxRegistered && Catalog.Limit("describeMs") == (long)options.DescribeBudget.TotalMilliseconds
            && Catalog.Limit("scriptMs") == (long)options.ScriptBudget.TotalMilliseconds && Catalog.Limit("gateWaitMs") == (long)options.GateWait.TotalMilliseconds
            && Catalog.Limit("messageChars") == ActionErrors.MaxMessage && Catalog.Limit("newName") == ExplorerRefs.MaxIdentifier
            && Catalog.Limit("stopGraceMs") == (long)options.StopGrace.TotalMilliseconds, "the backend's limits are the catalogue's");
        check(Catalog.ErrorCodes.Count() == 14 && Catalog.Retryable("IN_USE") && !Catalog.Retryable("DEPENDENTS") && Catalog.Retryable("CANCELLED") && !Catalog.ErrorCodes.Contains("INVALID_NAME")
            && Catalog.Dialogs.Keys.SequenceEqual(["deleteObject", "databaseProperties"]),
            "the catalogue lists the action error codes and the Delete Object and Database Properties dialogs");
    }

    private static void Lint(Action<bool, string> check)
    {
        var results = ActionSql.Lint().ToList();
        var problems = results.SelectMany(result => result.Problems.Select(problem => result.Name + ": " + problem)).ToList();
        check(problems.Count == 0 && results.Count == 9 * 2 + 6 * 5 + 2 + 6 * 2 + 2 + DatabaseAlter.Corpus(Catalog).Count() * 2, "every executable and catalog statement passes the lint at every band (" + results.Count + "): " + string.Join("; ", problems.Take(5)));
        // The lint must catch what it is for: a name spliced into the text, a name parameter outside QUOTENAME, a metadata function.
        check(ActionSql.LintExecutable("DECLARE @stmt nvarchar(max) = N'DROP TABLE ' + @p1;\nEXEC (@stmt);", ActionTemplate.DropTable).Count > 0
            && ActionSql.LintExecutable("DECLARE @stmt nvarchar(max) = N'DROP TABLE [dbo].[x]';\nEXEC (@stmt);", ActionTemplate.DropTable).Count > 0
            && ActionSql.LintExecutable("EXEC @rename @objname = @undeclared;", ActionTemplate.RenameObject).Count > 0
            && ActionSql.LintExecutable(ActionSql.Executable(ActionTemplate.DropTable).Replace("QUOTENAME(@db) + N'.sys.sp_executesql'", "@db + N'.sys.sp_executesql'", StringComparison.Ordinal), ActionTemplate.DropTable).Count > 0
            && ActionSql.LintExecutable(ActionSql.Executable(ActionTemplate.RenameObject).Replace("QUOTENAME(@db) + N'.sys.sp_rename'", "@db + N'.sys.sp_rename'", StringComparison.Ordinal), ActionTemplate.RenameObject).Count > 0
            && ActionSql.LintCatalog("SELECT OBJECT_ID(@name);", 16, database: true).Count > 0 && ActionSql.LintCatalog("SELECT USER_NAME(o.principal_id) FROM sys.objects AS o WHERE o.name = @name;", 16, database: true).Count > 0
            && ActionSql.LintCatalog("SELECT t.ledger_type FROM sys.tables AS t WHERE t.name = @name;", 15, database: true).Count > 0, "the lint refuses spliced names, bare name parameters, the database outside QUOTENAME, undeclared variables, metadata functions and band gates");
        // Every executable batch is constant text: no name ever reaches it.
        check(Enum.GetValues<ActionTemplate>().All(template => ActionSql.Executable(template) == ActionSql.Executable(template) && !InjectionMatrix.Fragments.Any(fragment => ActionSql.Executable(template).Contains(fragment[1..4], StringComparison.Ordinal))),
            "executable batches are constant text per template");
    }

    private static void ScriptText(Action<bool, string> check)
    {
        var failures = new List<string>();
        foreach (var fragment in InjectionMatrix.Fragments.Append("]").Append("'").Append(" ").Append("‮"))
        {
            var name = Long(fragment);
            var quoted = "[" + name.Replace("]", "]]", StringComparison.Ordinal) + "]";
            var plans = new[]
            {
                new PlannedStatement(ActionTemplate.DropTable, name, [name, name]), new PlannedStatement(ActionTemplate.DropView, name, [name, name]),
                new PlannedStatement(ActionTemplate.DropProcedure, name, [name, name]), new PlannedStatement(ActionTemplate.DropFunction, name, [name, name]),
                new PlannedStatement(ActionTemplate.RenameObject, name, [name, name, name]), new PlannedStatement(ActionTemplate.RenameDatabase, "master", [name, name]),
                new PlannedStatement(ActionTemplate.SetSingleUser, "master", [name]), new PlannedStatement(ActionTemplate.DropDatabase, "master", [name]),
                new PlannedStatement(ActionTemplate.DeleteBackupHistory, "msdb", [name])
            };
            foreach (var plan in plans)
            {
                var text = ActionSql.ScriptText(plan);
                var batches = SqlScript.Parse(text);
                // The query window splits the script where SSMS's does: one USE batch and one statement batch, whatever the name holds.
                if (batches.Count != (plan.Template == ActionTemplate.DeleteBackupHistory ? 1 : 2) || !batches[^1].Sql.Contains(ActionSql.Statement(plan), StringComparison.Ordinal))
                    failures.Add(plan.Template + " splits into " + batches.Count + " batches for " + fragment[..1]);
                if (!ActionSql.Statement(plan).Contains(plan.Template is ActionTemplate.DeleteBackupHistory or ActionTemplate.RenameObject ? name.Replace("'", "''", StringComparison.Ordinal) : quoted, StringComparison.Ordinal))
                    failures.Add(plan.Template + " does not quote " + fragment[..1]);
            }
        }
        check(failures.Count == 0, "Script Action text quotes hostile 128-unit names as QUOTENAME and N'' do, and splits into SSMS's batches: " + string.Join("; ", failures.Take(5)));
        check(ActionSql.ScriptText(new(ActionTemplate.DropTable, "AppData", ["dbo", "Orders"])) == "USE [AppData]" + NL + "GO" + NL + "DROP TABLE [dbo].[Orders]" + NL + "GO" + NL,
            "a table's DROP script is SSMS's: USE, GO, DROP TABLE, GO");
    }

    private static ActionArgs Delete(ObjectRefDto target, bool close = false, bool history = false) => new("delete", Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), target, null, close, history);
    private static ActionArgs Rename(ObjectRefDto target, string name) => new("rename", Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), target, name);

    private static void Plans(Action<bool, string> check)
    {
        var database = new ObjectRefDto("database", Name: "AppData");
        var full = string.Concat(ActionService.Plan(Delete(database, close: true, history: true), database).Select(ActionSql.ScriptText));
        // SSMS deletes the history first; Varia only after the DROP succeeded, so a DROP that fails (IN_USE) keeps it.
        check(full == "USE [master]" + NL + "GO" + NL + "ALTER DATABASE [AppData] SET  SINGLE_USER WITH ROLLBACK IMMEDIATE" + NL + "GO" + NL
            + "USE [master]" + NL + "GO" + NL + "DROP DATABASE [AppData]" + NL + "GO" + NL
            + "EXEC msdb.dbo.sp_delete_database_backuphistory @database_name = N'AppData'" + NL + "GO" + NL, "a database's Delete scripts single-user mode, the DROP, then its backup history");
        check(ActionService.Plan(Delete(database, history: true), database).Select(plan => plan.Template).SequenceEqual([ActionTemplate.DropDatabase, ActionTemplate.DeleteBackupHistory]),
            "the backup history step runs only after the DROP");
        check(ActionService.Plan(Delete(database), database).Select(plan => plan.Template).SequenceEqual([ActionTemplate.DropDatabase]),
            "without its options, deleting a database only drops it (Close existing connections is off by default, as in SSMS)");
        var view = new ObjectRefDto("view", "AppData", "dbo", "V");
        check(ActionService.Plan(Rename(view, "W"), view).Single() is { Template: ActionTemplate.RenameObject, Database: "AppData" } renamed && renamed.Names.SequenceEqual(["dbo", "V", "W"])
            && ActionService.Plan(Rename(database, "B"), database).Single() is { Template: ActionTemplate.RenameDatabase, Database: "master" }
            && ActionService.Plan(Delete(view), view).Single().Template == ActionTemplate.DropView, "rename and delete plans name the statement, its database and its names");
    }

    private static SqlException Sql(int number, byte level = 16, string message = "failed") => ConnectionFailureChecks.Sql(number, 1, level, "server", message);

    private static void Errors(Action<bool, string> check)
    {
        var expected = new Dictionary<int, string>
        {
            [1222] = "BLOCKED", [3702] = "IN_USE", [5030] = "IN_USE", [5061] = "IN_USE", [5070] = "IN_USE", [3726] = "DEPENDENTS", [3729] = "DEPENDENTS",
            [2714] = "NAME_IN_USE", [1801] = "NAME_IN_USE", [15335] = "NAME_IN_USE", [15225] = "NOT_FOUND", [229] = "PERMISSION_DENIED", [262] = "PERMISSION_DENIED",
            [297] = "PERMISSION_DENIED", [3701] = "PERMISSION_DENIED", [15247] = "PERMISSION_DENIED", [15151] = "PERMISSION_DENIED", [208] = "SQL_ERROR",
            // Database Properties (PR-B), and the file and filegroup numbers PR-B2's DDL will meet.
            [924] = "IN_USE", [5042] = "DEPENDENTS", [1828] = "NAME_IN_USE", [5170] = "NAME_IN_USE", [15007] = "NOT_FOUND", [5058] = "NOT_SUPPORTED"
        };
        var wrong = expected.Where(pair => ActionErrors.CodeOf(Sql(pair.Key), null) != pair.Value).Select(pair => pair.Key).ToList();
        check(wrong.Count == 0 && ActionErrors.CodeOf(Sql(50000, 20), null) == "CONNECTION_LOST" && ActionErrors.Numbers.Keys.All(Catalog.ErrorCodes.Contains),
            "SQL Server's error numbers map onto the action error codes: " + string.Join(", ", wrong));
        var inUse = ActionErrors.FromSql(Catalog, Sql(3702), null, ddl: true, inUseAdvice: ActionErrors.CloseConnectionsAdvice);
        check(inUse is { Code: "IN_USE", Retryable: true } && inUse.Message.EndsWith("Close its connections, or check Close existing connections.", StringComparison.Ordinal)
            && ActionErrors.FromSql(Catalog, Sql(1222), null, ddl: false, inUseAdvice: null).Message == "Another session holds a lock on the object; try again when it finishes."
            && ActionErrors.FromSql(Catalog, Sql(50000, 16, new string('m', 5000)), null, ddl: true, inUseAdvice: null).Message.Length == ActionErrors.MaxMessage,
            "error values carry SQL Server's message (clipped to 2,048 characters) with advice for IN_USE");
    }

    private static void Validation(Action<bool, string> check)
    {
        using var service = new ActionService(new FakeHost());
        var table = new ObjectRefDto("table", "AppData", "dbo", "Orders");
        string Refused(ActionArgs args)
        {
            try { service.Validate(args); return "accepted"; }
            catch (RequestException error) { return error.Code; }
        }
        var invalid = new (string Name, ActionArgs Args)[]
        {
            ("unknown action", Rename(table, "x") with { Action = "drop" }), ("connection id", Rename(table, "x") with { ConnectionId = "server-a" }),
            ("request id", Rename(table, "x") with { RequestId = "r1" }), ("ref shape", Rename(new ObjectRefDto("table", "AppData", Name: "Orders"), "x")),
            ("a kind without rename", Rename(new ObjectRefDto("login", Name: "sa"), "x")), ("U+0000", Rename(table, "a\0b")), ("129 units", Rename(table, new string('x', 129))),
            ("empty name", Rename(table, "")), ("the same name", Rename(table, "Orders")), ("delete flags on a rename", Rename(table, "x") with { CloseConnections = false }),
            ("a new name on a delete", Delete(table) with { NewName = "x" }), ("delete flags missing", Delete(table) with { DeleteHistory = null }),
            ("delete flags on a table", Delete(table, close: true)), ("a system database", Rename(new ObjectRefDto("database", Name: "master"), "x")),
            ("a system schema", Delete(new ObjectRefDto("view", "AppData", "sys", "objects"))), ("an aggregate's delete is offered by no row", Delete(new ObjectRefDto("synonym", "AppData", "dbo", "s")))
        };
        var accepted = invalid.Where(item => Refused(item.Args) != "INVALID_PARAMS").Select(item => item.Name).ToList();
        check(accepted.Count == 0, "Validate refuses what zod refuses: " + string.Join(", ", accepted));
        check(Refused(Rename(table, " ")) == "accepted" && Refused(Rename(table, Long("q]'); --"))) == "accepted" && Refused(Rename(table, "orders")) == "accepted"
            && Refused(Delete(new ObjectRefDto("database", Name: "AppData"), close: true, history: true)) == "accepted", "hostile, single-space and case-changed names are accepted verbatim");
        string DescribeRefused(ActionDescribeArgs args)
        {
            try { service.Validate(args); return "accepted"; }
            catch (RequestException error) { return error.Code; }
        }
        check(DescribeRefused(new(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "databaseProperties", table)) == "INVALID_PARAMS"
            && DescribeRefused(new(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "deleteObject", new ObjectRefDto("login", Name: "sa"))) == "INVALID_PARAMS"
            && DescribeRefused(new(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "deleteObject", table)) == "accepted", "describe refuses unknown dialogs and kinds the dialog does not serve");
        var sql = new SqlService();
        check(sql.LaneOf("actions.execute") == RequestLane.Actions && sql.LaneOf("actions.describe") == RequestLane.Metadata && sql.LaneOf("actions.script") == RequestLane.Metadata
            && new[] { "actions.describe", "actions.script", "actions.execute" }.All(SqlService.MethodNames.Contains), "DDL runs on the actions lane, never holding a metadata slot; HELLO lists the three methods");
        sql.Dispose();
        // Azure SQL Database refuses EXEC [db].sys.sp_executesql (Msg 40515): tables.columns opens in the object's database there.
        var azure = Box2022 with { EngineEdition = 5 };
        check(SqlService.ColumnsPerDatabase(azure, force: false) && !SqlService.ColumnsPerDatabase(Box2022, force: false) && SqlService.ColumnsPerDatabase(Box2022, force: true)
            && SqlService.ColumnsText(true) == SqlService.ColumnsSql && !SqlService.ColumnsText(true).Contains("sp_executesql", StringComparison.Ordinal)
            && SqlService.ColumnsText(false).Contains("QUOTENAME(@db) + N'.sys.sp_executesql'", StringComparison.Ordinal),
            "Select Top's column read on Azure SQL Database runs in the object's database with no cross-database call; box servers use QUOTENAME(@db)'s sp_executesql");
    }

    private sealed class FakeHost(int edition = 3) : IActionHost
    {
        public int Connections;
        public List<string> Cleared { get; } = [];
        public ServerProfile Profile(string connectionId) => Box2022 with { EngineEdition = edition };
        public SqlConnection Connection(string connectionId)
        {
            Interlocked.Increment(ref Connections);
            return new SqlConnection("Data Source=tcp:127.0.0.1,1;Connect Timeout=1;Pooling=false;Encrypt=false");
        }
        public Task OpenAsync(SqlConnection connection, CancellationToken token) => connection.OpenAsync(token);
        public bool ClearPoolsFor(string connectionId, string database) { Cleared.Add(database); return true; }
        public void DatabaseChanged(string connectionId, string database, string? newName) => Cleared.Add(database + " -> " + newName);
    }

    private static async Task ServiceAsync(Action<bool, string> check)
    {
        var cloudHost = new FakeHost(5);
        using var cloud = new ActionService(cloudHost);
        var table = new ObjectRefDto("table", "AppData", "dbo", "Orders");
        var describe = await cloud.DescribeAsync(new(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "deleteObject", table), CancellationToken.None);
        var script = await cloud.ScriptAsync(Delete(table), CancellationToken.None);
        var execute = await cloud.ExecuteAsync(Rename(table, "Orders2"), CancellationToken.None);
        check(describe.Error?.Code == "NOT_SUPPORTED" && script.Error?.Code == "NOT_SUPPORTED" && execute.Error?.Code == "NOT_SUPPORTED" && execute.Steps.Count == 0
            && execute.Error.Message == ActionService.CloudMessage && cloudHost.Connections == 0 && cloud.RunningCount == 0, "Azure SQL Database answers NOT_SUPPORTED before any connection opens");
        var host = new FakeHost();
        using var service = new ActionService(host);
        var unreachable = await service.ExecuteAsync(Rename(table, "Orders2"), CancellationToken.None);
        check(host.Connections == 1 && host.Cleared.Count == 0 && service.RunningCount == 0 && service.ActiveJobs == 0, "a failed open answers and frees the request, its gate and its job");
        _ = unreachable;
        var id = Guid.NewGuid().ToString();
        using var held = new CancellationTokenSource();
        var first = service.DescribeAsync(new(Guid.NewGuid().ToString(), id, "deleteObject", table), held.Token);
        string second;
        try { await service.DescribeAsync(new(Guid.NewGuid().ToString(), id, "deleteObject", table), CancellationToken.None); second = "accepted"; }
        catch (RequestException error) { second = error.Code; }
        held.Cancel();
        try { await first; } catch (OperationCanceledException) { } catch (RequestException) { }
        check(second == "DUPLICATE_REQUEST", "a request id runs once at a time");
    }
}
