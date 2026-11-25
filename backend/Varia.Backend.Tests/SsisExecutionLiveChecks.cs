using System.Globalization;
using System.Text.Json;
using Varia.Backend.Ssis;

namespace Varia.Backend.Tests;

/// <summary>Live checks of ssis.execution (the run page) and ssis.packageRuns (the package step) against the fake SSIS catalog
/// (VARIA_TEST_SQL_SCRATCH=1), reached through the internal SsisOptions.CatalogDatabase: an execution's overview, its messages counted
/// by type, the type and task filters, newest first, the task timeline with its statistics summed and its usual durations, the
/// parameters used (a sensitive value never read), the run strip and the next run, the package's runs with their counts, a message
/// cut at its bound, the row bound with `truncated`, and as values a purged execution (NOT_FOUND), a missing catalog
/// (CATALOG_MISSING), and a login that may not open or read the catalog (NO_DB_ACCESS, PERMISSION_DENIED). It only reads, and runs on
/// SQL Server on Linux too (IgnoreLinuxHost). Nothing here claims real SSIS behaviour: the fake's rows are inserted.</summary>
internal static class SsisExecutionLiveChecks
{
    private static string Literal(string value) => "N'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";
    private static string Bracket(string name) => "[" + name.Replace("]", "]]", StringComparison.Ordinal) + "]";
    private static string Dump(object? value) => JsonSerializer.Serialize(value, new JsonSerializerOptions(JsonSerializerDefaults.Web));

    private const string Folder = "Exec]ution's -- /*";

    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, Func<string, ConnectOptions> live, JsonSerializerOptions json,
        ScratchDatabase scratch, string db, Func<string, string, string?, Task<SqlRun>> sql)
    {
        async Task<SqlRun> Exec(string text)
        {
            var result = await sql(text, db, null);
            if (result.Status != "completed") throw new InvalidOperationException("SSIS execution fixture step failed: " + result.Error);
            return result;
        }
        var options = service.Ssis.Options;
        try
        {
            options.CatalogDatabase = db;
            options.IgnoreLinuxHost = true;
            service.Ssis.Forget(info.Id);
            Task<SsisExecutionResult> Read(long id, List<int>? types = null, string? connectionId = null, string? source = null) =>
                service.Ssis.ExecutionAsync(new(connectionId ?? info.Id, Guid.NewGuid().ToString(), id, types, source), CancellationToken.None);

            await Exec("EXEC [catalog].[varia_fake_seed] " + Literal(Folder) + ", N'Loads', N'Daily.dtsx';");
            async Task<long> Create(bool start)
                => long.Parse((await Exec("DECLARE @id bigint; EXEC [catalog].[create_execution] @folder_name = " + Literal(Folder) + ", @project_name = N'Loads', @package_name = N'Daily.dtsx', @execution_id = @id OUTPUT;\n"
                    + (start ? "EXEC [catalog].[start_execution] @execution_id = @id;\n" : "") + "SELECT @id;")).Scalar!, CultureInfo.InvariantCulture);
            // Two earlier runs that succeeded, with Load facts taking 1 s and 3 s: its usual duration is the lower middle, 1 s.
            var earlier = new List<long>();
            foreach (var ms in new[] { 1000, 3000 })
            {
                var run = await Create(false);
                earlier.Add(run);
                await Exec("UPDATE [catalog].[executions] SET status = 7, start_time = DATEADD(hour, -2, SYSDATETIMEOFFSET()), end_time = DATEADD(hour, -1, SYSDATETIMEOFFSET()) WHERE execution_id = " + run + ";\n"
                    + "INSERT [catalog].[executables] (execution_id, executable_name, package_name, package_path) VALUES (" + run + ", N'Load facts', N'Daily.dtsx', N'\\Daily\\Load facts');\n"
                    + "INSERT [catalog].[executable_statistics] (execution_id, executable_id, execution_path, start_time, end_time, execution_duration, execution_result) "
                    + "SELECT " + run + ", x.executable_id, x.package_path, SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), " + ms + ", 0 FROM [catalog].[executables] AS x WHERE x.execution_id = " + run + ";");
            }
            var id = await Create(true);
            var later = await Create(false);
            // This run's executables: the package, Load facts twice in a loop (one failed), and Notify, which never ran.
            await Exec("DECLARE @t datetimeoffset(7) = DATEADD(minute, -10, SYSDATETIMEOFFSET());\n"
                + "INSERT [catalog].[executables] (execution_id, executable_name, package_name, package_path) VALUES (" + id + ", N'Daily', N'Daily.dtsx', N'\\Daily'), "
                + "(" + id + ", N'Load facts', N'Daily.dtsx', N'\\Daily\\Load facts'), (" + id + ", N'Notify', N'Daily.dtsx', N'\\Daily\\Notify');\n"
                + "INSERT [catalog].[executable_statistics] (execution_id, executable_id, execution_path, start_time, end_time, execution_duration, execution_result) "
                + "SELECT " + id + ", x.executable_id, x.package_path, @t, DATEADD(second, 5, @t), 5000, 1 FROM [catalog].[executables] AS x WHERE x.execution_id = " + id + " AND x.executable_name = N'Daily' UNION ALL "
                + "SELECT " + id + ", x.executable_id, x.package_path, DATEADD(second, 1, @t), DATEADD(second, 2, @t), 500, 0 FROM [catalog].[executables] AS x WHERE x.execution_id = " + id + " AND x.executable_name = N'Load facts' UNION ALL "
                + "SELECT " + id + ", x.executable_id, x.package_path, DATEADD(second, 2, @t), DATEADD(second, 4, @t), 3000, 1 FROM [catalog].[executables] AS x WHERE x.execution_id = " + id + " AND x.executable_name = N'Load facts';\n"
                + "INSERT [catalog].[execution_parameter_values] (execution_id, object_type, parameter_data_type, parameter_name, parameter_value, sensitive, required, value_set, runtime_override) VALUES "
                + "(" + id + ", 30, N'Int32', N'BatchSize', CAST(5000 AS int), 0, 0, 1, 1);\n"
                // One row per INSERT: a VALUES list would give both sql_variant values one type.
                + "INSERT [catalog].[execution_parameter_values] (execution_id, object_type, parameter_data_type, parameter_name, parameter_value, sensitive, required, value_set, runtime_override) VALUES "
                + "(" + id + ", 20, N'String', N'VariaSecret', CAST(N'hunter2' AS nvarchar(20)), 1, 1, 1, 0);");
            // Messages a second apart, oldest first: progress, information, a warning, then a long error with an event row.
            var longMessage = "Error: " + new string('x', 4100);
            await Exec("DECLARE @t datetimeoffset(7) = DATEADD(minute, -10, SYSDATETIMEOFFSET());\n"
                + "INSERT [catalog].[operation_messages] (operation_id, message_time, message_type, message_source_type, message) VALUES "
                + "(" + id + ", DATEADD(second, 1, @t), 60, 30, N'Validating: 50% complete'), (" + id + ", DATEADD(second, 2, @t), 70, 40, N'Rows read: 12'), "
                + "(" + id + ", DATEADD(second, 3, @t), 110, 60, N'Truncation may occur'), (" + id + ", DATEADD(second, 4, @t), 120, 40, " + Literal(longMessage) + ");\n"
                + "INSERT [catalog].[varia_event_messages] (event_message_id, operation_id, package_name, event_name, message_source_name, execution_path, message_code) "
                + "SELECT operation_message_id, operation_id, N'Daily.dtsx', N'OnError', N'Load facts', N'\\Daily\\Load facts', -1071636471 FROM [catalog].[operation_messages] WHERE operation_id = " + id + " AND message_type = 120;");
            var all = await Read(id);
            var model = all.Model;
            check(all.Error is null && model is { Truncated: false } && model.Overview.Id == id && model.Overview.Folder == Folder && model.Overview.Project == "Loads" && model.Overview.Package == "Daily.dtsx"
                && model.Overview.Status == 2 && model.Overview.Started is not null && model.Overview.Ended is null && model.Overview.Now.Length > 20
                && model.Counts.Select(item => (item.Type, item.Count)).SequenceEqual([(60, 1L), (70, 1L), (110, 1L), (120, 1L)])
                && model.Types is null && model.Source is null && model.Messages.Select(message => message.Type).SequenceEqual([120, 110, 70, 60]),
                "an execution read answers its overview (folder, project, package, Running, started, the server's clock), every message counted by type, and its messages newest first: " + Dump(all.Error) + " " + Dump(model?.Counts));
            var error = model?.Messages.FirstOrDefault();
            check(error is { Package: "Daily.dtsx", Event: "OnError", Source: "Load facts", Path: "\\Daily\\Load facts", Code: -1071636471, SourceType: 40 } && error.Message.Length == 4000 && error.Message.EndsWith('…')
                && model!.Messages[1] is { Package: null, Event: null, Message: "Truncation may occur" },
                "an error message carries its event columns, and one past 4,000 characters is cut with an ellipsis; an operation-only message has none: " + error?.Message.Length);

            var errors = await Read(id, [120]);
            var quiet = await Read(id, [110, 60]);
            var task = await Read(id, source: "Load facts");
            check(errors.Model is { Types: [120] } && errors.Model.Messages.Select(message => message.Type).SequenceEqual([120]) && errors.Model.Counts.Count == 4
                && quiet.Model is { Types: [60, 110] } && quiet.Model.Messages.Select(message => message.Type).SequenceEqual([110, 60])
                && task.Model is { Source: "Load facts" } && task.Model.Messages.Select(message => message.Type).SequenceEqual([120]) && task.Model.Counts.Count == 4,
                "the type filter keeps the chosen message types and the task filter one task's messages, while the counts cover every message");

            var tasks = model!.Tasks;
            check(tasks.Select(item => item.Name).SequenceEqual(["Daily", "Load facts", "Notify"]) && !model.TasksTruncated
                && tasks[1] is { Path: "\\Daily\\Load facts", Runs: 2, DurationMs: 3500, Failed: true, UsualMs: 1000 } && tasks[1].Started is not null && tasks[1].Ended is not null
                && tasks[2] is { Started: null, Ended: null, DurationMs: null, Runs: 0, Failed: false, UsualMs: null } && tasks[0] is { DurationMs: 5000, Failed: true },
                "the task timeline lists the executables in the order they started (one that never ran last), each with its statistics summed and its usual duration: " + Dump(tasks));
            var batch = model.Parameters.SingleOrDefault(item => item.Name == "BatchSize");
            var secret = model.Parameters.SingleOrDefault(item => item.Name == "VariaSecret");
            check(batch is { ObjectType: 30, DataType: "Int32", Value: "5000", Sensitive: false, ValueSet: true, RuntimeOverride: true }
                && secret is { ObjectType: 20, Value: null, Sensitive: true, Required: true } && !Dump(model).Contains("hunter2", StringComparison.Ordinal),
                "the parameters used carry each value as text, and a sensitive parameter's value is never read: " + Dump(model.Parameters));
            check(model.Runs.Select(run => run.Id).SequenceEqual([id, earlier[1], earlier[0]]) && model.Runs[1].Status == 7 && model.Runs[1].Started is not null && model.Newer == later,
                "the run strip holds this run and the package's runs before it, newest first, and the package's next run: " + Dump(model.Runs) + " " + model.Newer);
            var packageRuns = await service.Ssis.PackageRunsAsync(new(info.Id, Guid.NewGuid().ToString(), Folder, "Loads", "Daily.dtsx"), CancellationToken.None);
            var none = await service.Ssis.PackageRunsAsync(new(info.Id, Guid.NewGuid().ToString(), Folder, "Loads", "Missing.dtsx"), CancellationToken.None);
            check(packageRuns.Error is null && packageRuns.Model is { Truncated: false } && packageRuns.Model.Runs.Select(run => run.Id).SequenceEqual([later, id, earlier[1], earlier[0]])
                && packageRuns.Model.Runs[1] is { Errors: 1, Warnings: 1 } && packageRuns.Model.Runs[0] is { Errors: 0, Warnings: 0 } && packageRuns.Model.Runs[1].Caller is not null
                && none.Model is { Runs.Count: 0 } && none.Error is null,
                "the package step lists the package's runs newest first with their error and warning counts, and a package without runs is an empty list: " + Dump(packageRuns.Error) + Dump(packageRuns.Model?.Runs));

            // Past the bound: the newest 5,000 of 5,004 messages, truncated, the oldest left out.
            await Exec("INSERT [catalog].[operation_messages] (operation_id, message_time, message_type, message_source_type, message) "
                + "SELECT TOP (5000) " + id + ", SYSDATETIMEOFFSET(), 70, 40, N'bulk' FROM sys.all_columns AS a CROSS JOIN sys.all_columns AS b;");
            var many = await Read(id);
            var after = await Read(id, [110]);
            check(many.Model is { Truncated: true } && many.Model.Messages.Count == 5000 && many.Model.Messages.All(message => message.Message == "bulk")
                && many.Model.Counts.Sum(item => item.Count) == 5004 && after.Model is { Truncated: false } && after.Model.Messages.Count == 1,
                "a read holds the newest 5,000 messages and says it is truncated, and the next read on the pool works");

            // Purged by the retention cleanup (or never there): NOT_FOUND as a value.
            await Exec("DELETE FROM [catalog].[varia_event_messages] WHERE operation_id = " + id + ";\n"
                + "DELETE FROM [catalog].[operation_messages] WHERE operation_id = " + id + ";\nDELETE FROM [catalog].[executions] WHERE execution_id = " + id + ";\nDELETE FROM [catalog].[operations] WHERE operation_id = " + id + ";");
            var purged = await Read(id);
            check(purged.Error is { Code: "NOT_FOUND", Retryable: false } && purged.Error.Message.Contains("retention cleanup", StringComparison.Ordinal) && purged.Model is null,
                "a purged execution answers NOT_FOUND, saying the catalog's retention cleanup may have removed it: " + Dump(purged.Error));

            // No catalog on the server.
            options.CatalogDatabase = "VariaMissing_" + Guid.NewGuid().ToString("N")[..8];
            service.Ssis.Forget(info.Id);
            var missing = await Read(5);
            check(missing.Error is { Code: "CATALOG_MISSING", Retryable: false }, "an execution read on a server without the catalog answers CATALOG_MISSING: " + Dump(missing.Error));
            options.CatalogDatabase = db;
            service.Ssis.Forget(info.Id);

            // A login that may not open the catalog's database, then one that may not read its executions.
            if (scratch.Login is null && !await scratch.CreateLoginAsync())
            {
                Console.WriteLine("The execution read's permission checks are skipped: this server accepts Windows logins only.");
                return;
            }
            var login = scratch.Login!;
            await Exec("IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = " + Literal(login) + ") CREATE USER " + Bracket(login) + " FOR LOGIN " + Bracket(login) + ";\n"
                + "GRANT SELECT ON SCHEMA::[catalog] TO " + Bracket(login) + ";");
            var reader = (ConnectionInfo)await service.DispatchAsync("connections.connect", JsonSerializer.SerializeToElement(live("master") with
            {
                Authentication = "sql", Username = login, Password = scratch.Password
            }, json), json);
            try
            {
                await Exec("REVOKE CONNECT FROM " + Bracket(login) + ";");
                SsisExecutionResult closed;
                try { closed = await Read(5, connectionId: reader.Id); }
                finally { await Exec("GRANT CONNECT TO " + Bracket(login) + ";"); }
                await Exec("DENY SELECT ON [catalog].[executions] TO " + Bracket(login) + ";");
                SsisExecutionResult denied;
                try { service.Ssis.Forget(reader.Id); denied = await Read(5, connectionId: reader.Id); }
                finally { await Exec("REVOKE SELECT ON [catalog].[executions] FROM " + Bracket(login) + ";"); }
                check(closed.Error is { Code: "NO_DB_ACCESS", Retryable: false } && denied.Error is { Code: "PERMISSION_DENIED", Retryable: false } && denied.Error.Message.Contains("execution 5", StringComparison.Ordinal),
                    "a login that may not open the catalog answers NO_DB_ACCESS, and one that may not read its executions PERMISSION_DENIED naming the execution: " + Dump(closed.Error) + Dump(denied.Error));
            }
            finally
            {
                await service.DispatchAsync("connections.disconnect", JsonSerializer.SerializeToElement(new ConnectionArgs(reader.Id), json), json);
            }
        }
        finally
        {
            options.CatalogDatabase = SsisCatalog.Current.CatalogDatabase;
            options.IgnoreLinuxHost = false;
            service.Ssis.Forget(info.Id);
            service.ClearPoolsFor(info.Id, db);
        }
    }
}
