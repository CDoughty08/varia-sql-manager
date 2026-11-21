using System.Data;
using System.Globalization;
using Microsoft.Data.SqlClient;
using Varia.Backend.Agent;
using Varia.Backend.Explorer;

namespace Varia.Backend.Actions;

/// <summary>SQL Server Agent Properties from the Agent node (AG-8a). The describe reads sp_get_sqlagent_properties (every Agent role), the server's
/// clock and, for sysadmin, every job's history counts; it says read-only on Managed Instance (which refuses sp_set_sqlagent_properties) and below
/// sysadmin (msdb grants that procedure to no role), and the settings read-only on Linux, where Delete old history still runs. The action's execute runs one server write (AgentSql.Properties.cs): the changed settings,
/// or the purge of every job's history older than a cut-off the server computes; never both, and never on Managed Instance.</summary>
internal sealed partial class ActionService
{
    internal const string AgentPropertiesStoppedMessage = "SQL Server Agent is not running (Agent XPs is off), so its properties cannot be read. Start it, then try again.";
    internal const string AgentPropertiesManagedInstance = "Managed Instance does not allow changing SQL Server Agent properties.";
    /// <summary>SQL Server on Linux keeps Agent's settings in mssql.conf: sp_set_sqlagent_properties' registry writes end the session there.</summary>
    internal const string AgentPropertiesLinux = "On Linux, SQL Server Agent's settings are set with mssql-conf, so they cannot change here.";
    internal const string AgentPropertiesNotSysadmin = "Only sysadmin can change SQL Server Agent properties.";
    internal const string AgentHistoryHidden = "Only sysadmin can read every job's history, so what these settings keep is not shown.";
    internal const string AgentHistoryUnread = "Every job's history could not be read, so what these settings keep is not shown.";
    internal const string SavePropertiesStep = "Save SQL Server Agent properties";
    internal const string PurgeHistoryStep = "Delete old job history";

    /// <summary>Re-validates agentPropertiesRequestSchema (src/shared/actions/agent-properties.ts). Null for any other action, after refusing
    /// the Agent Properties members on it.</summary>
    private ObjectRefDto? ValidateAgentProperties(ActionArgs args)
    {
        if (args.Action != "agentProperties")
        {
            if (args.AgentProperties is not null || args.AgentPurge is not null) throw Invalid(args.Action + " takes no agentProperties or agentPurge.");
            return null;
        }
        if (args.Target is not { Kind: "agent", Name: null, Database: null, Schema: null, Parent: null, SsisFolder: null, SsisProject: null }) throw Invalid("target.");
        var target = Target(args.Target, args.Action);
        if (args with { AgentProperties = null, AgentPurge = null } != new ActionArgs(args.Action, args.ConnectionId, args.RequestId, args.Target)) throw Invalid("agentProperties takes only its changes or its purge.");
        if ((args.AgentProperties is null) == (args.AgentPurge is null)) throw Invalid("send either agentProperties or agentPurge.");
        var max = (int)AgentCatalog.Current.Limit("historyMaxRows");
        if (args.AgentProperties is { } changes)
        {
            if (changes is { SqlserverRestart: null, MonitorAutostart: null, HistoryMaxRows: null, HistoryMaxRowsPerJob: null }) throw Invalid("there is nothing to change.");
            if (changes.HistoryMaxRows is { } rows && rows != -1 && (rows < 2 || rows > max)) throw Invalid("historyMaxRows.");
            if (changes.HistoryMaxRowsPerJob is { } perJob && (perJob < 1 || changes.HistoryMaxRows is not { } log || log == -1 || perJob > log)) throw Invalid("historyMaxRowsPerJob.");
        }
        if (args.AgentPurge is { } purge && (purge.Count < 1 || purge.Count > AgentCatalog.Current.Limit("purgeCount") || purge.Unit is < 1 or > 3
            || (purge.Before is { } before && PurgeBefore(before) is null))) throw Invalid("agentPurge.");
        return target;
    }

    /// <summary>The purge's confirmed cut-off as a datetime, or null unless it is exactly yyyy-MM-ddTHH:mm:ss inside datetime's range (19 characters,
    /// agentHistoryPurgeSchema's bound).</summary>
    internal static DateTime? PurgeBefore(string text) =>
        text.Length == 19 && DateTime.TryParseExact(text, "yyyy-MM-dd'T'HH:mm:ss", CultureInfo.InvariantCulture, DateTimeStyles.None, out var value) && value.Year >= 1753 ? value : null;

    private static int? Int(object? value) => value is null or DBNull ? null : Convert.ToInt32(value, CultureInfo.InvariantCulture);
    private static string? Text(object? value) => value is null or DBNull ? null : Convert.ToString(value, CultureInfo.InvariantCulture);

    private async Task<ActionDescribeResult> DescribeAgentPropertiesAsync(SqlConnection connection, ServerProfile profile, CancellationToken token)
    {
        string now;
        int offset;
        bool sysadmin, linux;
        await using (var command = connection.CreateCommand())
        {
            command.CommandText = AgentSql.Clock;
            command.CommandTimeout = 0;
            await using var reader = await command.ExecuteReaderAsync(token);
            if (!await reader.ReadAsync(token)) return new(null, 0, Error("SQL_ERROR", AgentReader.FailedMessage));
            (now, offset, sysadmin, linux) = (reader.GetString(0).Trim(), reader.GetInt32(1), reader.GetInt32(2) == 1, reader.GetInt32(3) == 1);
        }
        var (results, errors) = await new AgentReader().ReadAsync(connection, null, [AgentSql.AgentProperties], (_, _) => null, token);
        if (errors.FirstOrDefault() is { } failed)
            return new(null, 0, failed.Code == "AGENT_DISABLED" ? Error("AGENT_STOPPED", AgentPropertiesStoppedMessage)
                : Error(failed.Code is "PERMISSION_DENIED" or "NOT_SUPPORTED" or "TIMEOUT" ? failed.Code : "SQL_ERROR", failed.Message));
        var read = results["agentProperties"];
        if (read.Rows.Count == 0) return new(null, 0, Error("SQL_ERROR", AgentReader.FailedMessage));
        object? Value(string column) => read.Value(read.Rows[0], column);
        var settings = new AgentSettingsDto(Int(Value("sqlserver_restart")) == 1, Int(Value("monitor_autostart")) == 1, Int(Value("jobhistory_max_rows")) ?? -1, Int(Value("jobhistory_max_rows_per_job")) ?? 0,
            Int(Value("auto_start")) is { } start ? start == 1 : null, Text(Value("startup_account")), Text(Value("errorlog_file")), Int(Value("errorlogging_level")));
        var managed = profile.Explorer(explorer).ServerEngine == "managedInstance";
        var readOnly = managed ? AgentPropertiesManagedInstance : sysadmin ? null : AgentPropertiesNotSysadmin;
        var settingsNote = readOnly is null && !WritesProperties(profile.EngineEdition, profile.Linux || linux) ? AgentPropertiesLinux : null;
        if (!sysadmin) return new(null, 0, AgentProperties: new(settings, now, offset, readOnly, null, AgentHistoryHidden));
        try { return new(null, 0, AgentProperties: new(settings, now, offset, readOnly, await ReadAgentHistoryAsync(connection, token), SettingsNote: settingsNote)); }
        catch (SqlException) when (!token.IsCancellationRequested && connection.State == ConnectionState.Open)
        {
            return new(null, 0, AgentProperties: new(settings, now, offset, readOnly, null, AgentHistoryUnread, settingsNote));
        }
    }

    /// <summary>The history counts (AgentSql.HistoryCounts): the total and recent rows, the jobs with the most rows, the rows by age.</summary>
    private static async Task<AgentHistoryFactsDto> ReadAgentHistoryAsync(SqlConnection connection, CancellationToken token)
    {
        var limits = AgentCatalog.Current;
        var jobsCap = (int)limits.Limit("retentionJobs");
        await using var command = connection.CreateCommand();
        command.CommandText = AgentSql.HistoryCounts;
        command.CommandTimeout = 0;
        Add(command, "@days", SqlDbType.Int, 0, (int)limits.Limit("retentionDays"));
        Add(command, "@jobs", SqlDbType.Int, 0, jobsCap + 1);
        Add(command, "@ages", SqlDbType.Int, 0, (int)limits.Limit("historyAgeDays"));
        await using var reader = await command.ExecuteReaderAsync(token);
        long total = 0, recent = 0;
        if (await reader.ReadAsync(token)) (total, recent) = (reader.GetInt64(0), reader.GetInt64(1));
        var jobs = new List<AgentRetentionJobDto>();
        var truncated = false;
        if (await reader.NextResultAsync(token))
            while (await reader.ReadAsync(token))
            {
                if (jobs.Count == jobsCap) { truncated = true; break; }
                jobs.Add(new(reader.GetString(0), reader.GetInt64(1), reader.GetInt64(2)));
            }
        var ages = new List<AgentHistoryAgeDto>();
        if (await reader.NextResultAsync(token))
            while (await reader.ReadAsync(token)) ages.Add(new(reader.GetInt32(0), reader.GetInt64(1)));
        return new(total, recent, jobs, truncated, [.. ages.OrderBy(age => age.Days)]);
    }

    /// <summary>The script, as SSMS writes it: the settings' sp_set_sqlagent_properties with only the changed arguments, or the purge with the
    /// cut-off computed from the server's clock as the action computes it. Script reads nothing.</summary>
    internal static string AgentPropertiesScript(ActionArgs args)
    {
        static string Bit(bool value) => value ? "1" : "0";
        if (args.AgentPurge is { } purge)
        {
            var unit = purge.Unit switch { 1 => "day", 2 => "week", _ => "month" };
            return "USE [msdb]\nGO\nDECLARE @oldest_date datetime = DATEADD(" + unit + ", -" + purge.Count.ToString(CultureInfo.InvariantCulture) + ", GETDATE());\n"
                + "EXEC msdb.dbo.sp_purge_jobhistory @oldest_date=@oldest_date\nGO\n";
        }
        var changes = args.AgentProperties!;
        var parts = new List<string>();
        if (changes.SqlserverRestart is { } restart) parts.Add("@sqlserver_restart=" + Bit(restart));
        if (changes.MonitorAutostart is { } monitor) parts.Add("@monitor_autostart=" + Bit(monitor));
        if (changes.HistoryMaxRows is { } rows) parts.Add("@jobhistory_max_rows=" + rows.ToString(CultureInfo.InvariantCulture));
        if (changes.HistoryMaxRowsPerJob is { } perJob) parts.Add("@jobhistory_max_rows_per_job=" + perJob.ToString(CultureInfo.InvariantCulture));
        return "USE [msdb]\nGO\nEXEC msdb.dbo.sp_set_sqlagent_properties " + string.Join(", ", parts) + "\nGO\n";
    }

    /// <summary>Whether the platform takes the settings write (the agentPropertiesWrite gate: Windows only; Linux sets them with mssql-conf).</summary>
    private static bool WritesProperties(int engineEdition, bool linux) =>
        AgentCatalog.Current.PlatformOf(engineEdition, linux) is { } platform && AgentCatalog.Current.Offers("agentPropertiesWrite", platform);

    private ActionError? AgentPropertiesRefusal(ActionArgs args)
    {
        var profile = host.Profile(args.ConnectionId);
        var engine = profile.Explorer(explorer).ServerEngine;
        if (engine == "managedInstance") return Error("NOT_SUPPORTED", AgentPropertiesManagedInstance);
        if (args.AgentProperties is not null && profile.Linux && !WritesProperties(profile.EngineEdition, true)) return Error("NOT_SUPPORTED", AgentPropertiesLinux);
        return Serves("agentProperties", engine) ? null : Error("NOT_SUPPORTED", EngineMessage(engine));
    }

    private Task<ActionScriptResult> ScriptAgentProperties(ActionArgs args) =>
        Task.FromResult(AgentPropertiesRefusal(args) is { } refused ? new ActionScriptResult(null, "msdb", [], refused) : new ActionScriptResult(AgentPropertiesScript(args), "msdb", []));

    /// <summary>The write, its step title and its parameters' values: the settings' four (NULL leaves one as it is), or the purge's count, unit and
    /// confirmed cut-off (NULL: none, the server's own).</summary>
    internal static (AgentWrite Write, string Title, object?[] Values) AgentPropertiesPlan(ActionArgs args)
    {
        static object? Bit(bool? value) => value is { } on ? (on ? 1 : 0) : null;
        if (args.AgentPurge is { } purge) return (AgentSql.PurgeHistory, PurgeHistoryStep, [purge.Count, purge.Unit, purge.Before is { } before ? PurgeBefore(before) : null]);
        var changes = args.AgentProperties!;
        return (AgentSql.SetProperties, SavePropertiesStep, [Bit(changes.SqlserverRestart), Bit(changes.MonitorAutostart), changes.HistoryMaxRows, changes.HistoryMaxRowsPerJob]);
    }

    private async Task<ActionExecuteResult> ExecuteAgentPropertiesAsync(SqlConnection connection, ActionArgs args, CancellationToken token)
    {
        var (write, title, values) = AgentPropertiesPlan(args);
        // sp_purge_jobhistory reports how many rows it deleted as an informational message (14226).
        var messages = CollectMessages(connection);
        var step = new RunStep(title, async context =>
        {
            try
            {
                // The connect probe can fall back to "not Linux", so the settings write asks the server itself before msdb's registry writes.
                if (write == AgentSql.SetProperties)
                {
                    bool linux;
                    await using (var platform = connection.CreateCommand())
                    {
                        platform.CommandText = AgentSql.Platform;
                        await using var read = await platform.ExecuteReaderAsync(context.Token);
                        linux = await read.ReadAsync(context.Token) && read.GetInt32(0) == 1;
                    }
                    if (linux && !WritesProperties(host.Profile(args.ConnectionId).EngineEdition, true)) throw new StepRefusedException(Error("NOT_SUPPORTED", AgentPropertiesLinux));
                }
                await using var command = connection.CreateCommand();
                command.CommandText = write.Text;
                command.CommandTimeout = 0;
                for (var i = 0; i < write.Parameters.Count; i++) Add(command, write.Parameters[i].Name, write.Parameters[i].Type, write.Parameters[i].Size, values[i]);
                await ReadAllAsync(command, context.Token);
            }
            catch (SqlException error) when (!context.Token.IsCancellationRequested && FirstNumber(error) == 15281)
            {
                throw new StepRefusedException(Error("AGENT_STOPPED", AgentStoppedMessage));
            }
        });
        var (steps, failure, _) = await RunStepsAsync(connection, [step], null, token, CleanupBudget(args.Action));
        return new(steps, messages.Collected(), 0, failure);
    }
}
