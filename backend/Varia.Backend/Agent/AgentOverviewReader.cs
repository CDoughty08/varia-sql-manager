using System.Data;
using System.Globalization;
using Microsoft.Data.SqlClient;
using Varia.Backend.Explorer;
using Varia.Backend.Live;

namespace Varia.Backend.Agent;

/// <summary>
/// The agent.overview live source (AG-15, docs/sql-server-agent.md › Agent overview): its one probe gathers the facts the overview's health
/// checks need, which src/shared/agent/overview.ts turns into checks. Every read goes through <see cref="AgentReader"/> (so under the Agent read
/// lint) on the server pool, except the service state, which is LiveSql's explorer.agentService text. Reads every Agent role may make run for
/// everyone (msdb filters what each sees); the sysadmin reads (owners' logins, history counts, schedule use, Agent mail, service account) run
/// only when the login is sysadmin and are otherwise recorded as <c>role</c>; alerts off Windows, which has none, as <c>platform</c>. A refused
/// read is a value in the reads table (its live error code and message), never a failed probe, so the other checks still show. Tables: jobs
/// (with the owner and history facts where read), alerts, schedules and reads. Nothing is logged.
/// </summary>
internal sealed class AgentOverviewReader(AgentCatalog? catalog = null) : ILiveSqlReader
{
    public const string Source = "agent.overview";
    public const string ReadProbe = "agent.overview.read";
    /// <summary>The reads table's ids, in the order the reader records them (src/shared/agent/overview.ts overviewReads).</summary>
    public static readonly string[] Reads = ["facts", "state", "clock", "jobs", "properties", "alerts", "profiles", "owners", "history", "schedules", "mail", "service"];

    private readonly AgentCatalog catalog = catalog ?? AgentCatalog.Current;
    private int band = LiveSql.MaxBand;
    private string? platform;
    private string? version;

    /// <summary>The reader the probe runs its statements through (offline checks give one with a TestRun).</summary>
    internal AgentReader Reader { get; init; } = new();
    /// <summary>Reads the service state in place of the server (offline checks only): Agent XPs, state and startup type, or a failure.</summary>
    internal Func<(int? Xps, int? State, int? Startup)>? TestService { get; init; }
    /// <summary>The server's Agent platform (offline checks set it; the live path takes it from the profile).</summary>
    internal string? Platform { get => platform; init => platform = value; }

    public async Task<(int Spid, bool ServerState)> SessionAsync(SqlConnection connection, string prologue, string permission, CancellationToken token)
    {
        await using var command = connection.CreateCommand();
        command.CommandTimeout = 0;
        command.CommandText = prologue + LiveSql.Session;
        command.Parameters.Add(new SqlParameter("@permission", SqlDbType.NVarChar, 128) { Value = permission });
        command.Parameters.Add(new SqlParameter("@catalog", SqlDbType.NVarChar, 128) { Value = DBNull.Value });
        await using var row = await command.ExecuteReaderAsync(CommandBehavior.SingleRow, token).ConfigureAwait(false);
        if (!await row.ReadAsync(token).ConfigureAwait(false)) throw new InvalidOperationException("The session probe returned no row.");
        return (Convert.ToInt32(row.GetValue(0), CultureInfo.InvariantCulture), Convert.ToInt32(row.GetValue(1), CultureInfo.InvariantCulture) == 1);
    }

    public (string Reason, string Note)? Unavailable(LiveProbeJson spec, ServerProfile profile)
    {
        band = LiveConnections.Band(profile);
        platform = catalog.PlatformOf(profile.EngineEdition, profile.Linux);
        version = profile.ProductVersion;
        return null;
    }

    public void Apply(object value) { }

    public void Reset() { }

    public async Task<LiveReaderSample> ReadAsync(SqlConnection connection, string prologue, LiveDue item, Func<string, string, string>? testText, CancellationToken token)
    {
        if (item.Probe.Spec.Id != ReadProbe) throw new RequestException("BACKEND_ERROR", "agent.overview has no such probe.");
        return await SampleAsync(connection, prologue, testText, token).ConfigureAwait(false);
    }

    private sealed record ReadOutcome(string Id, string State, string? Message, bool Truncated);

    /// <summary>One sample: every read in <see cref="Reads"/> order, each recorded in the reads table.</summary>
    internal async Task<LiveReaderSample> SampleAsync(SqlConnection? connection, string prologue, Func<string, string, string>? testText, CancellationToken token)
    {
        var outcomes = new List<ReadOutcome>();
        var status = new List<LiveStatus>();
        if (platform is not null) status.Add(new("platform", platform));
        if (version is { Length: > 0 } product) status.Add(new("productVersion", product.Length > 128 ? product[..128] : product));

        AgentResult? Run(Dictionary<string, AgentResult> results, List<AgentReadError> errors, string id, AgentStatement statement)
        {
            if (results.TryGetValue(statement.Id, out var result)) { outcomes.Add(new(id, "ok", null, result.Truncated)); return result; }
            var error = errors.FirstOrDefault(item => item.Statement == statement.Id);
            outcomes.Add(new(id, error?.Code ?? "SQL_ERROR", error?.Message ?? AgentReader.FailedMessage, false));
            return null;
        }
        void Skip(string id, string why) => outcomes.Add(new(id, why, null, false));

        // Who reads: sysadmin decides which reads run; a failed facts read runs the role reads only.
        var (facts, factErrors) = await Reader.ReadAsync(connection, prologue, [AgentSql.JobDocumentFacts], NoValues, token).ConfigureAwait(false);
        var factRows = Run(facts, factErrors, "facts", AgentSql.JobDocumentFacts);
        var sysadmin = false;
        if (factRows is { Rows.Count: > 0 })
        {
            sysadmin = Int(factRows.Value(factRows.Rows[0], "is_sysadmin")) == 1;
            status.Add(new("isSysadmin", sysadmin ? 1L : 0L));
            if (Int(factRows.Value(factRows.Rows[0], "mail_xps")) is { } mailXps) status.Add(new("mailXps", (long)mailXps));
        }

        await StateAsync(connection, prologue, testText, status, outcomes, token).ConfigureAwait(false);

        // Alerts are Windows only (agentPlatformGates.alerts): Linux and Managed Instance have none.
        var noAlerts = platform is not null and not "windows";
        List<AgentStatement> statements = [AgentSql.ServerClock, AgentSql.OverviewJobs, AgentSql.Properties];
        if (!noAlerts) statements.Add(AgentSql.OverviewAlerts);
        statements.Add(AgentSql.MailProfiles);
        if (sysadmin) statements.AddRange([AgentSql.OverviewOwners, AgentSql.OverviewHistory, AgentSql.Schedules, AgentSql.AgentMail, AgentSql.OverviewService]);
        var (results, errors) = await Reader.ReadAsync(connection, prologue, statements, NoValues, token).ConfigureAwait(false);

        if (Run(results, errors, "clock", AgentSql.ServerClock) is { Rows.Count: > 0 } clock && clock.Value(clock.Rows[0], "server_now") is DateTime now)
            status.Add(new("serverNow", Stamp(now)));
        var jobs = Run(results, errors, "jobs", AgentSql.OverviewJobs);
        if (Run(results, errors, "properties", AgentSql.Properties) is { Rows.Count: > 0 } properties)
        {
            if (Int(properties.Value(properties.Rows[0], "jobhistory_max_rows")) is { } max) status.Add(new("historyMaxRows", (long)max));
            if (Int(properties.Value(properties.Rows[0], "jobhistory_max_rows_per_job")) is { } perJob) status.Add(new("historyMaxRowsPerJob", (long)perJob));
        }
        var alerts = noAlerts ? null : Run(results, errors, "alerts", AgentSql.OverviewAlerts);
        if (noAlerts) Skip("alerts", "platform");
        var profiles = Run(results, errors, "profiles", AgentSql.MailProfiles);
        if (profiles is not null) status.Add(new("mailProfiles", (long)profiles.Rows.Count));

        AgentResult? owners = null, history = null, schedules = null;
        if (sysadmin)
        {
            owners = Run(results, errors, "owners", AgentSql.OverviewOwners);
            history = Run(results, errors, "history", AgentSql.OverviewHistory);
            schedules = Run(results, errors, "schedules", AgentSql.Schedules);
            if (Run(results, errors, "mail", AgentSql.AgentMail) is { Rows.Count: > 0 } mail)
            {
                if (Int(mail.Value(mail.Rows[0], "use_databasemail")) is { } use) status.Add(new("useDatabaseMail", (long)use));
                if (mail.Value(mail.Rows[0], "databasemail_profile") is string { Length: > 0 } profile)
                {
                    status.Add(new("agentProfile", Clip(profile)));
                    if (profiles is not null)
                        status.Add(new("agentProfileFound", profiles.Rows.Any(row => string.Equals(profiles.Value(row, "name") as string, profile, StringComparison.OrdinalIgnoreCase)) ? 1L : 0L));
                }
            }
            if (Run(results, errors, "service", AgentSql.OverviewService) is { Rows.Count: > 0 } service && service.Value(service.Rows[0], "service_account") is string { Length: > 0 } account)
                status.Add(new("serviceAccount", Clip(account)));
        }
        else if (factRows is { Rows.Count: > 0 })
            foreach (var id in (string[])["owners", "history", "schedules", "mail", "service"]) Skip(id, "role");
        else
        {
            // Who reads is unknown: the sysadmin reads did not run for the facts read's own reason, not for a role.
            var why = outcomes.First(outcome => outcome.Id == "facts");
            foreach (var id in (string[])["owners", "history", "schedules", "mail", "service"]) outcomes.Add(why with { Id = id, State = why.State == "ok" ? "SQL_ERROR" : why.State });
        }

        var ownerStates = new Dictionary<Guid, int>();
        if (owners is not null)
            foreach (var row in owners.Rows)
                if (owners.Value(row, "job_id") is Guid id && Int(owners.Value(row, "owner_state")) is { } state) ownerStates[id] = state;
        var kept = new Dictionary<Guid, (long Rows, long Runs, DateTime? Oldest)>();
        if (history is not null)
            foreach (var row in history.Rows)
                if (history.Value(row, "job_id") is Guid id)
                    kept[id] = (Long(history.Value(row, "history_rows")) ?? 0, Long(history.Value(row, "history_runs")) ?? 0, StampOf(Long(history.Value(row, "oldest_run"))));

        var jobRows = (jobs?.Rows ?? []).Select(row => JobRow(jobs!, row, ownerStates, owners is not null, kept, history is not null)).Where(row => row is not null).Select(row => row!).ToList();
        var alertRows = (alerts?.Rows ?? []).Select(row => AlertRow(alerts!, row)).ToList();
        var scheduleRows = (schedules?.Rows ?? []).Select(row => ScheduleRow(schedules!, row)).ToList();
        var readRows = outcomes.Select(outcome => new LiveRow([LiveCell.Of(outcome.Id), LiveCell.Of(outcome.State), LiveCell.Of(outcome.Message), LiveCell.Of(outcome.Truncated ? 1L : 0L)])).ToList();
        return new(null, [
            new(0, jobRows, jobs?.Truncated == true ? 1 : 0), new(1, alertRows, alerts?.Truncated == true ? 1 : 0), new(2, scheduleRows, schedules?.Truncated == true ? 1 : 0), new(3, readRows)
        ], [], Status: status);
    }

    /// <summary>Agent XPs, the service's state and startup type through explorer.agentService's text (HAS_PERMS_BY_NAME decides what it reads).</summary>
    private async Task StateAsync(SqlConnection? connection, string prologue, Func<string, string, string>? testText, List<LiveStatus> status, List<ReadOutcome> outcomes, CancellationToken token)
    {
        (int? Xps, int? State, int? Startup) read;
        try
        {
            if (TestService is { } test) read = test();
            else
            {
                await using var command = (connection ?? throw new InvalidOperationException("An Agent read needs a connection.")).CreateCommand();
                command.CommandTimeout = 0;
                var text = prologue + LiveSql.AgentServiceAt(band);
                command.CommandText = testText?.Invoke(ReadProbe, text) ?? text;
                await using var reader = await command.ExecuteReaderAsync(CommandBehavior.SingleRow, token).ConfigureAwait(false);
                if (!await reader.ReadAsync(token).ConfigureAwait(false)) throw new InvalidOperationException("The Agent state read returned no row.");
                int? Number(int ordinal) => reader.IsDBNull(ordinal) ? null : Convert.ToInt32(reader.GetValue(ordinal), CultureInfo.InvariantCulture);
                read = (Number(0), Number(1), Number(2));
            }
        }
        catch (SqlException error) when (!token.IsCancellationRequested)
        {
            var value = AgentReader.Classify(AgentSql.State, error);
            if (LiveErrors.Breaks(value.Code) || value.Code == "LOGIN_FAILED") throw;
            outcomes.Add(new("state", value.Code, value.Message, false));
            return;
        }
        outcomes.Add(new("state", "ok", null, false));
        if (read.Xps is { } xps) status.Add(new("agentXps", (long)xps));
        if (read.State is { } state) status.Add(new("serviceState", (long)state));
        if (read.Startup is { } startup) status.Add(new("startupType", (long)startup));
    }

    private static LiveRow? JobRow(AgentResult jobs, object?[] row, Dictionary<Guid, int> owners, bool ownersRead, Dictionary<Guid, (long Rows, long Runs, DateTime? Oldest)> history, bool historyRead)
    {
        if (jobs.Value(row, "job_id") is not Guid id) return null;
        var lastRun = RunTime(Int(jobs.Value(row, "last_run_date")), Int(jobs.Value(row, "last_run_time")));
        var kept = history.TryGetValue(id, out var found) ? found : ((long Rows, long Runs, DateTime? Oldest)?)null;
        return new LiveRow([
            LiveCell.Of(id), LiveCell.Of(jobs.Value(row, "name") as string), LiveCell.Of(Long(jobs.Value(row, "enabled"))), LiveCell.Of(jobs.Value(row, "owner") as string),
            LiveCell.Of(jobs.Value(row, "category") as string), LiveCell.Of(Long(jobs.Value(row, "last_run_outcome"))), LiveCell.Of(lastRun is { } at ? Stamp(at) : null),
            LiveCell.Of(Long(jobs.Value(row, "current_execution_status"))), LiveCell.Of(Long(jobs.Value(row, "notify_level_email"))), LiveCell.Of(Long(jobs.Value(row, "notify_level_page"))),
            LiveCell.Of(Long(jobs.Value(row, "notify_level_netsend"))), LiveCell.Of(Long(jobs.Value(row, "has_schedule"))),
            // Read but absent is a job sysjobs did not list (created since): unknown, not "can log in".
            ownersRead && owners.TryGetValue(id, out var owner) ? LiveCell.Of((long)owner) : LiveCell.Null,
            historyRead ? LiveCell.Of(kept?.Rows ?? 0) : LiveCell.Null, historyRead ? LiveCell.Of(kept?.Runs ?? 0) : LiveCell.Null,
            LiveCell.Of(kept?.Oldest is { } oldest ? Stamp(oldest) : null),
            LiveCell.Of(jobs.Value(row, "date_created") is DateTime created ? Stamp(created) : null)
        ]);
    }

    private static LiveRow AlertRow(AgentResult alerts, object?[] row)
    {
        var last = RunTime(Int(alerts.Value(row, "last_occurrence_date")), Int(alerts.Value(row, "last_occurrence_time")));
        return new LiveRow([
            LiveCell.Of(alerts.Value(row, "name") as string), LiveCell.Of(Long(alerts.Value(row, "enabled"))), LiveCell.Of(Long(alerts.Value(row, "message_id"))),
            LiveCell.Of(Long(alerts.Value(row, "severity"))), LiveCell.Of(last is { } at ? Stamp(at) : null), LiveCell.Of(Long(alerts.Value(row, "has_notification")))
        ]);
    }

    private static LiveRow ScheduleRow(AgentResult schedules, object?[] row) => new([
        LiveCell.Of(Long(schedules.Value(row, "schedule_id"))), LiveCell.Of(schedules.Value(row, "schedule_name") as string), LiveCell.Of(Long(schedules.Value(row, "enabled"))),
        LiveCell.Of(Long(schedules.Value(row, "job_count")))
    ]);

    /// <summary>msdb's int date (yyyymmdd) and time (hhmmss) as a time; 0 (never) or an impossible value is none.</summary>
    internal static DateTime? RunTime(int? date, int? time)
    {
        if (date is not { } day || day <= 0) return null;
        var clock = time ?? 0;
        try { return new DateTime(day / 10000, day / 100 % 100, day % 100, clock / 10000, clock / 100 % 100, clock % 100, DateTimeKind.Unspecified); }
        catch (ArgumentOutOfRangeException) { return null; }
    }

    private static DateTime? StampOf(long? value) => value is { } number ? RunTime((int)(number / 1_000_000), (int)(number % 1_000_000)) : null;

    /// <summary>A server-local time as the overview's text (yyyy-MM-ddTHH:mm:ss), which src/shared/agent/overview.ts parses.</summary>
    internal static string Stamp(DateTime time) => time.ToString("yyyy-MM-dd'T'HH:mm:ss", CultureInfo.InvariantCulture);

    private static string Clip(string text) => text.Length > 128 ? text[..128] : text;
    private static object? NoValues(AgentStatement statement, AgentParameter parameter) => null;
    private static int? Int(object? value) => value is null or DBNull ? null : Convert.ToInt32(value, CultureInfo.InvariantCulture);
    private static long? Long(object? value) => value is null or DBNull ? null : Convert.ToInt64(value, CultureInfo.InvariantCulture);
}
