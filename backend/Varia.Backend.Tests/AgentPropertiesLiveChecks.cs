using System.Text.Json;
using Microsoft.Data.SqlClient;
using Varia.Backend.Actions;
using Varia.Backend.Agent;

namespace Varia.Backend.Tests;

/// <summary>Live checks of SQL Server Agent Properties (AG-8a), part of the Agent suite with VARIA_TEST_SQL_SCRATCH=1, on this run's scratch job:
/// the describe as sysadmin; OK toggling "Auto restart SQL Server Agent" and sending the history sizes as they are, every setting restored in
/// finally; Delete old history on the scratch job's own planted rows from 1930 (skipped when any other job has history that old, so nobody
/// else's history is touched); and a SQLAgentUserRole login, which reads the properties, is not sysadmin and is refused the write.</summary>
internal static class AgentPropertiesLiveChecks
{
    private static string Quote(string value) => "N'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";
    private static string Bracket(string value) => "[" + value.Replace("]", "]]", StringComparison.Ordinal) + "]";

    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, JsonSerializerOptions json, ScratchDatabase scratch, Guid job,
        SqlConnection connection, Func<string, string, Task<SqlRun>> sql)
    {
        async Task<T> Call<T>(string method, object args) => (T)await service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, json), json);
        var agent = new ObjectRefDto("agent");
        Task<ActionDescribeResult> Describe() => Call<ActionDescribeResult>("actions.describe", new ActionDescribeArgs(info.Id, Guid.NewGuid().ToString(), "agentProperties", agent));
        Task<ActionExecuteResult> Execute(AgentPropertiesChangesDto? changes = null, AgentHistoryPurgeDto? purge = null) =>
            Call<ActionExecuteResult>("actions.execute", new ActionArgs("agentProperties", info.Id, Guid.NewGuid().ToString(), agent) { AgentProperties = changes, AgentPurge = purge });
        static string Steps(ActionExecuteResult result) => string.Join(", ", result.Steps.Select(step => step.Status + ":" + step.Title)) + (result.Error is { } error ? " " + error.Code + " " + error.Message : "");

        var before = await Describe();
        var settings = before.AgentProperties?.Settings;
        // msdb's own answer, read apart from the describe: sp_get_sqlagent_properties' columns differ by version, so a reader picks them by name.
        string? stored = null;
        await using (var command = new SqlCommand("EXEC msdb.dbo.sp_get_sqlagent_properties;", connection))
        await using (var read = await command.ExecuteReaderAsync())
            if (await read.ReadAsync())
                stored = string.Join(",", new[] { "sqlserver_restart", "monitor_autostart", "jobhistory_max_rows", "jobhistory_max_rows_per_job" }.Select(column => Convert.ToString(read[column], System.Globalization.CultureInfo.InvariantCulture)));
        var expected = settings is null ? null : string.Join(",", settings.SqlserverRestart ? 1 : 0, settings.MonitorAutostart ? 1 : 0, settings.HistoryMaxRows, settings.HistoryMaxRowsPerJob);
        check(before is { Error: null, AgentProperties: { ReadOnly: null, History: not null, HistoryNote: null } model } && model.ServerNow.Length == 19
            && stored == expected,
            "as sysadmin, SQL Server Agent Properties describes msdb's settings, the server's clock and every job's history counts, editable: "
            + JsonSerializer.Serialize(before.AgentProperties?.Settings) + " " + before.Error?.Message + " msdb: " + stored);
        if (settings is null) return;

        // On Linux mssql-conf sets Agent's settings and sp_set_sqlagent_properties' registry writes end the session: the settings show
        // read-only and OK is refused before any batch runs.
        if (before.AgentProperties?.SettingsNote is { } note)
        {
            var refused = await Execute(new(null, !settings.MonitorAutostart, null, null));
            check(note == ActionService.AgentPropertiesLinux && refused.Error is { Code: "NOT_SUPPORTED" } && refused.Steps.Count == 0,
                "on Linux SQL Server Agent Properties shows the settings read-only and refuses OK's write before it runs: " + Steps(refused));
        }
        else try
        {
            // OK: the restart box toggles and comes back; the history sizes go as they are, so nothing trims anyone's history.
            var toggled = await Execute(new(null, !settings.MonitorAutostart, null, null));
            var flipped = await Describe();
            var sizes = await Execute(settings.HistoryMaxRows == -1 ? new(null, null, -1, null) : new(null, null, settings.HistoryMaxRows, settings.HistoryMaxRowsPerJob));
            var kept = await Describe();
            check(toggled.Error is null && toggled.Steps is [{ Status: "done", Title: ActionService.SavePropertiesStep }] && flipped.AgentProperties?.Settings.MonitorAutostart == !settings.MonitorAutostart
                && flipped.AgentProperties.Settings with { MonitorAutostart = settings.MonitorAutostart } == settings
                && sizes.Error is null && kept.AgentProperties is { } after && after.Settings with { MonitorAutostart = settings.MonitorAutostart } == settings,
                "OK changes only the setting sent (msdb leaves a NULL argument alone), and sends the history sizes as SSMS does: " + Steps(toggled) + " | " + Steps(sizes));
        }
        finally
        {
            await sql("EXEC msdb.dbo.sp_set_sqlagent_properties @monitor_autostart = " + (settings.MonitorAutostart ? "1" : "0") + ", @sqlserver_restart = " + (settings.SqlserverRestart ? "1" : "0")
                + (settings.HistoryMaxRows == -1 ? ", @jobhistory_max_rows = -1" : ", @jobhistory_max_rows = " + settings.HistoryMaxRows + ", @jobhistory_max_rows_per_job = " + settings.HistoryMaxRowsPerJob) + ";", "msdb");
        }
        var restored = await Describe();
        check(restored.AgentProperties?.Settings == settings, "the live checks leave SQL Server Agent's properties as they found them: " + JsonSerializer.Serialize(restored.AgentProperties?.Settings));

        // Delete old history on the scratch job's own rows: 999 months back is in the 1940s, so only rows planted in 1930 are older. The
        // precheck counts other jobs' rows up to the same server-computed cut-off day, so nobody else's history is deleted.
        var id = "'" + job.ToString("D") + "'";
        var others = await sql("SELECT COUNT_BIG(*) FROM msdb.dbo.sysjobhistory WHERE run_date <= CONVERT(int, CONVERT(char(8), DATEADD(month, -999, GETDATE()), 112)) AND job_id <> " + id + ";", "msdb");
        if (others.Status != "completed" || others.Scalar != "0") Console.WriteLine("SQL Server Agent Properties' purge check skipped: another job has history older than 999 months, which it would delete.");
        else
        {
            var planted = await sql("INSERT INTO msdb.dbo.sysjobhistory (job_id, step_id, step_name, sql_message_id, sql_severity, message, run_status, run_date, run_time, run_duration, operator_id_emailed, operator_id_netsent, operator_id_paged, retries_attempted, server)\n"
                + "VALUES (" + id + ", 0, N'(Job outcome)', 0, 0, N'varia.scratch', 1, 19300101, 120000, 1, 0, 0, 0, 0, @@SERVERNAME), (" + id + ", 1, N'Step 1', 0, 0, N'varia.scratch', 1, 19300101, 120000, 1, 0, 0, 0, 0, @@SERVERNAME);", "msdb");
            var counted = await Describe();
            // A purge of one day bounded by a confirmed 1920 cut-off deletes nothing newer than 1920: the planted rows stay.
            var bounded = await Execute(purge: new(1, 1, "1920-01-01T00:00:00"));
            var stayed = await sql("SELECT COUNT(*) FROM msdb.dbo.sysjobhistory WHERE job_id = " + id + " AND run_date = 19300101;", "msdb");
            check(bounded.Error is null && stayed.Scalar == "2", "Delete old history never deletes past the cut-off the confirmation showed, whatever the server's clock says: "
                + Steps(bounded) + " left " + (stayed.Scalar ?? stayed.Error));
            var purged = await Execute(purge: new(999, 3));
            var left = await sql("SELECT CONCAT(SUM(CASE WHEN run_date = 19300101 THEN 1 ELSE 0 END), ',', COUNT(*)) FROM msdb.dbo.sysjobhistory WHERE job_id = " + id + ";", "msdb");
            var oldest = (int)AgentCatalog.Current.Limit("historyAgeDays");
            check(planted.Status == "completed" && counted.AgentProperties?.History?.Ages.FirstOrDefault(age => age.Days == oldest)?.Rows >= 2
                && purged.Error is null && purged.Steps is [{ Status: "done", Title: ActionService.PurgeHistoryStep }] && left.Scalar is { } kept && kept.StartsWith("0,", StringComparison.Ordinal) && kept != "0,0",
                "Delete old history counts the planted 1930 rows among the oldest and deletes them, before a cut-off the server computes, keeping the job's real history: "
                + planted.Error + " " + Steps(purged) + " left " + (left.Scalar ?? left.Error) + " messages " + string.Join(" | ", purged.Messages));
        }

        // A SQLAgentUserRole login reads the properties but is not sysadmin, so the dialog is read-only, and msdb refuses the write.
        var login = scratch.OwnLogin("agp");
        var made = await sql("CREATE LOGIN " + Bracket(login) + " WITH PASSWORD = " + Quote(ScratchDatabase.Throwaway()) + ", CHECK_POLICY = OFF;", "master");
        try
        {
            var mapped = await sql("CREATE USER " + Bracket(login) + " FOR LOGIN " + Bracket(login) + ";\nALTER ROLE SQLAgentUserRole ADD MEMBER " + Bracket(login) + ";", "msdb");
            int? sysadmin = null;
            int? refused = null;
            List<AgentReadError> errors = [];
            await Run("EXECUTE AS LOGIN = " + Quote(login) + ";");
            try
            {
                await using (var clock = new SqlCommand(AgentSql.Clock, connection))
                await using (var read = await clock.ExecuteReaderAsync())
                    if (await read.ReadAsync()) sysadmin = read.GetInt32(2);
                (_, errors) = await new AgentReader().ReadAsync(connection, null, [AgentSql.AgentProperties], (_, _) => null, CancellationToken.None);
                try
                {
                    await using var write = new SqlCommand(AgentSql.SetProperties.Text, connection);
                    write.Parameters.Add(new SqlParameter("@sqlserver_restart", System.Data.SqlDbType.Int) { Value = DBNull.Value });
                    write.Parameters.Add(new SqlParameter("@monitor_autostart", System.Data.SqlDbType.Int) { Value = settings.MonitorAutostart ? 1 : 0 });
                    write.Parameters.Add(new SqlParameter("@jobhistory_max_rows", System.Data.SqlDbType.Int) { Value = DBNull.Value });
                    write.Parameters.Add(new SqlParameter("@jobhistory_max_rows_per_job", System.Data.SqlDbType.Int) { Value = DBNull.Value });
                    await write.ExecuteNonQueryAsync();
                    refused = 0;
                }
                catch (SqlException error) { refused = error.Number; }
            }
            finally { await Run("REVERT;"); }
            check(made.Status == "completed" && mapped.Status == "completed" && sysadmin == 0 && errors.Count == 0 && refused is { } number && ActionErrors.Numbers["PERMISSION_DENIED"].Contains(number),
                "a SQLAgentUserRole login reads Agent's properties, is not sysadmin (so the dialog opens read-only), and msdb refuses its write as PERMISSION_DENIED: "
                + made.Error + mapped.Error + " sysadmin " + sysadmin + " refused " + refused + " " + string.Join(", ", errors.Select(error => error.Statement + " " + error.Code)));
        }
        finally { await sql("IF USER_ID(" + Quote(login) + ") IS NOT NULL DROP USER " + Bracket(login) + ";", "msdb"); }

        async Task Run(string text)
        {
            await using var command = new SqlCommand(text, connection);
            await command.ExecuteNonQueryAsync();
        }
    }
}
