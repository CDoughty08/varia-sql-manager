using System.Globalization;
using System.Text.Json;
using Varia.Backend.Ssis;

namespace Varia.Backend.Tests;

/// <summary>Live checks of ssis.execution (AG-13) against the fake SSIS catalog (VARIA_TEST_SQL_SCRATCH=1), reached through the
/// internal SsisOptions.CatalogDatabase: an execution's overview, its messages counted by type, the type filter, newest first,
/// a message cut at its bound, the row bound with `truncated`, and as values a purged execution (NOT_FOUND), a missing catalog
/// (CATALOG_MISSING), and a login that may not open or read the catalog (NO_DB_ACCESS, PERMISSION_DENIED). It only reads, and
/// runs on SQL Server on Linux too (IgnoreLinuxHost). Nothing here claims real SSIS behaviour: the fake's messages are inserted.</summary>
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
            Task<SsisExecutionResult> Read(long id, List<string>? groups = null, string? connectionId = null) =>
                service.Ssis.ExecutionAsync(new(connectionId ?? info.Id, Guid.NewGuid().ToString(), id, groups), CancellationToken.None);

            await Exec("EXEC [catalog].[varia_fake_seed] " + Literal(Folder) + ", N'Loads', N'Daily.dtsx';");
            var id = long.Parse((await Exec("DECLARE @id bigint; EXEC [catalog].[create_execution] @folder_name = " + Literal(Folder) + ", @project_name = N'Loads', @package_name = N'Daily.dtsx', @execution_id = @id OUTPUT;\n"
                + "EXEC [catalog].[start_execution] @execution_id = @id;\nSELECT @id;")).Scalar!, CultureInfo.InvariantCulture);
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
                && model.Groups.SequenceEqual(["error", "warning", "information", "other"]) && model.Messages.Select(message => message.Type).SequenceEqual([120, 110, 70, 60]),
                "an execution read answers its overview (folder, project, package, Running, started, the server's clock), every message counted by type, and its messages newest first: " + Dump(all.Error) + " " + Dump(model?.Counts));
            var error = model?.Messages.FirstOrDefault();
            check(error is { Package: "Daily.dtsx", Event: "OnError", Source: "Load facts", Path: "\\Daily\\Load facts", Code: -1071636471, SourceType: 40 } && error.Message.Length == 4000 && error.Message.EndsWith('…')
                && model!.Messages[1] is { Package: null, Event: null, Message: "Truncation may occur" },
                "an error message carries its event columns, and one past 4,000 characters is cut with an ellipsis; an operation-only message has none: " + error?.Message.Length);

            var errors = await Read(id, ["error"]);
            var quiet = await Read(id, ["warning", "other"]);
            check(errors.Model is { Groups: ["error"] } && errors.Model.Messages.Select(message => message.Type).SequenceEqual([120]) && errors.Model.Counts.Count == 4
                && quiet.Model is { Groups: ["warning", "other"] } && quiet.Model.Messages.Select(message => message.Type).SequenceEqual([110, 60]),
                "the type filter keeps the chosen groups' messages, Other every type the others do not name, while the counts cover every message");

            // Past the bound: the newest 5,000 of 5,004 messages, truncated, the oldest left out.
            await Exec("INSERT [catalog].[operation_messages] (operation_id, message_time, message_type, message_source_type, message) "
                + "SELECT TOP (5000) " + id + ", SYSDATETIMEOFFSET(), 70, 40, N'bulk' FROM sys.all_columns AS a CROSS JOIN sys.all_columns AS b;");
            var many = await Read(id);
            var after = await Read(id, ["warning"]);
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
