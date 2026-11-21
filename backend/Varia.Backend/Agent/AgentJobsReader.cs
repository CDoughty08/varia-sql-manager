using System.Data;
using System.Globalization;
using Microsoft.Data.SqlClient;
using Varia.Backend.Explorer;
using Varia.Backend.Live;

namespace Varia.Backend.Agent;

/// <summary>agent.jobs' args (src/shared/agent/jobs.ts agentJobsArgsSchema): the job whose last run the list reads, the jobs the
/// status bar watches (slots by order) and the list's column value filters.</summary>
internal sealed record AgentJobsLiveArgs(string? Expand = null, string[]? Watch = null, AgentJobColumnFilterDto[]? Filters = null);
internal sealed record AgentJobColumnFilterDto(string? Column, string?[]? Values = null, bool? Blanks = null, bool? NonBlanks = null, bool? Exclude = null);

/// <summary>Checks agent.jobs' args as main's schema does.</summary>
internal static class AgentJobsArgs
{
    public static readonly string[] FilterColumns = ["status", "lastOutcome", "category"];
    public const int FilterValues = 64;
    public const int FilterChars = 128;

    public static AgentJobsLiveArgs Check(AgentJobsLiveArgs args, AgentCatalog catalog)
    {
        static RequestException Invalid(string message) => new("INVALID_PARAMS", message);
        if (args.Expand is not null && !IsUuid(args.Expand)) throw Invalid("The expanded job is a job id.");
        if (args.Watch is { } watch && (watch.Length is 0 || watch.Length > catalog.Limit("watchedJobs") || watch.Any(id => !IsUuid(id))
            || watch.Select(id => id!.ToLowerInvariant()).Distinct(StringComparer.Ordinal).Count() != watch.Length))
            throw Invalid("Watch names up to " + catalog.Limit("watchedJobs") + " jobs once each.");
        if (args.Filters is { } filters)
        {
            if (filters.Length > FilterColumns.Length || filters.Any(filter => filter is null || filter.Column is null || !FilterColumns.Contains(filter.Column))
                || filters.Select(filter => filter.Column).Distinct(StringComparer.Ordinal).Count() != filters.Length)
                throw Invalid("A column value filter names one of status, lastOutcome and category, once.");
            foreach (var filter in filters)
            {
                var values = filter.Values ?? [];
                if (values.Length > FilterValues || values.Any(value => value is null || value.Length > FilterChars)) throw Invalid("A column value filter has up to 64 values of up to 128 characters.");
                if (values.Length == 0 && filter.Blanks != true && filter.NonBlanks != true) throw Invalid("A column filter needs a value, (Blanks) or (Non-blanks).");
                if (filter.Exclude == true && (values.Length == 0 || filter.NonBlanks == true)) throw Invalid("An excluding filter names values, without (Non-blanks).");
            }
        }
        return args;
    }

    private static bool IsUuid(string? value) => value is { Length: 36 } && Guid.TryParseExact(value, "D", out _);
}

/// <summary>
/// The agent.jobs live source (docs/sql-server-agent.md, Job Activity Monitor): its three probes read through msdb's own
/// procedures by <see cref="AgentReader"/>, so every Agent role sees the jobs msdb shows it, plus the service state through
/// LiveSql's explorer.agentService text. agent.jobs.list builds one row per job with SSMS's columns, the tiles' counts and,
/// for the expanded job, its last run's rows; agent.jobs.service carries Agent XPs and the service's state; agent.jobs.watched
/// fills fixed slot series for the jobs the status bar follows. A refused read is a value: the list's own read failing fails
/// the probe; the elapsed times or the last run failing leave only their own part empty. Nothing is logged.
/// </summary>
internal sealed class AgentJobsReader(AgentJobsLiveArgs? args = null, AgentCatalog? catalog = null) : ILiveSqlReader
{
    public const string Source = "agent.jobs";
    public const string ListProbe = "agent.jobs.list";
    public const string ServiceProbe = "agent.jobs.service";
    public const string WatchedProbe = "agent.jobs.watched";
    /// <summary>The execution statuses that count as running (src/shared/agent/catalog.ts runningExecutionStatuses).</summary>
    private static readonly int[] Running = [1, 2, 3, 7];
    private static readonly string[] WatchedFields = ["Status", "Step", "Steps", "Started", "LastOutcome", "LastRun"];
    /// <summary>A watched slot's status for a job msdb no longer has (src/shared/agent/jobs.ts watchedGoneStatus).</summary>
    public const int GoneStatus = -1;
    /// <summary>The last run's words for an expanded job no longer in the list.</summary>
    public const string GoneMessage = "This job is no longer in the list: it was deleted, or this login no longer sees it.";

    private readonly AgentCatalog catalog = catalog ?? AgentCatalog.Current;
    private readonly Lock gate = new();
    private AgentJobsLiveArgs current = args ?? new();
    private int band = LiveSql.MaxBand;

    /// <summary>The reader the probes run their statements through (offline checks give one with a TestRun).</summary>
    internal AgentReader Reader { get; init; } = new();
    /// <summary>Reads the service state in place of the server (offline checks only): Agent XPs, state and startup type.</summary>
    internal Func<(int? Xps, int? State, int? Startup)>? TestService { get; init; }

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
        // The catalogue's gates already left out Express and the cloud editions; the service text depends on the band.
        band = LiveConnections.Band(profile);
        return null;
    }

    public void Apply(object value)
    {
        lock (gate) current = (AgentJobsLiveArgs)value;
    }

    public void Reset() { }

    /// <summary>The args in force (the checks read them).</summary>
    internal AgentJobsLiveArgs Current { get { lock (gate) return current; } }

    public async Task<LiveReaderSample> ReadAsync(SqlConnection connection, string prologue, LiveDue item, Func<string, string, string>? testText, CancellationToken token)
    {
        AgentJobsLiveArgs now;
        lock (gate) now = current;
        return item.Probe.Spec.Id switch
        {
            ListProbe => await ListAsync(connection, prologue, item, now, token).ConfigureAwait(false),
            ServiceProbe => await ServiceAsync(connection, prologue, testText, token).ConfigureAwait(false),
            WatchedProbe => await WatchedAsync(connection, prologue, now, token).ConfigureAwait(false),
            _ => throw new RequestException("BACKEND_ERROR", "agent.jobs has no such probe.")
        };
    }

    // --- agent.jobs.list ---------------------------------------------------------------------------------------------

    private async Task<LiveReaderSample> ListAsync(SqlConnection? connection, string prologue, LiveDue item, AgentJobsLiveArgs now, CancellationToken token)
    {
        var (results, errors) = await Reader.ReadAsync(connection, prologue, [AgentSql.JobActivity], NoValues, token).ConfigureAwait(false);
        if (!results.TryGetValue(AgentSql.JobActivity.Id, out var jobs)) return Failed(ListProbe, errors[0]);
        var probeErrors = new List<LiveProbeError>();
        var list = jobs.Rows.Select(row => Job.Of(jobs, row)).ToList();
        // Elapsed times only while a job runs: sp_help_jobactivity for the Agent's current session and the server's clock.
        Dictionary<Guid, DateTime> starts = [];
        DateTime? serverNow = null;
        if (list.Any(job => job.IsRunning))
            (starts, serverNow) = await StartsAsync(connection, prologue, ListProbe, probeErrors, [0], token).ConfigureAwait(false);
        var rows = list.Select(job => Row(job, starts.TryGetValue(job.Id, out var start) && serverNow is { } clock ? clock - start : null)).ToList();
        var view = item.View;
        var filters = (now.Filters ?? []).Where(filter => filter is not null).ToArray();
        Func<LiveRow, bool> viewed = row => InView(view, row);
        Func<LiveRow, bool> kept = row => viewed(row) && Passes(filters, row);
        var tables = new List<LiveReaderTable> { new(0, rows, jobs.Truncated ? 1 : 0, view is null && filters.Length == 0 ? null : kept, view is null ? null : viewed) };
        if (now.Expand is { } expand && Guid.TryParse(expand, out var expanded) && list.Any(job => job.Id == expanded))
        {
            var (history, failed) = await Reader.ReadAsync(connection, prologue, [AgentSql.LastRunHistory], (_, _) => expanded, token).ConfigureAwait(false);
            if (history.TryGetValue(AgentSql.LastRunHistory.Id, out var runs))
            {
                var (lastRows, more) = LastRun(runs);
                tables.Add(new(1, lastRows, more));
            }
            else
            {
                probeErrors.Add(Error(ListProbe, failed[0]) with { Tables = [1] });
                tables.Add(new(1, []));
            }
        }
        else
        {
            // The expanded job left the list (deleted, or this login no longer sees it): its last run says so, not "no run".
            if (now.Expand is not null) probeErrors.Add(LiveErrors.Create(ListProbe, "NOT_FOUND", GoneMessage) with { Tables = [1] });
            tables.Add(new(1, []));
        }
        double?[] values =
        [
            list.Count(job => job.IsRunning), list.Count(job => job.LastOutcome == 0), list.Count(job => job.Status == 3), list.Count(job => !job.Enabled)
        ];
        return new(new LiveRawSample(null, null, values, new double?[values.Length]), tables, probeErrors);
    }

    private static object? NoValues(AgentStatement statement, AgentParameter parameter) => null;

    /// <summary>Running jobs' starts for the Agent's current session, and the server's clock; a refusal is an error value naming the
    /// list's elapsed column (or the watched series) and leaves no elapsed time, never a guess.</summary>
    private async Task<(Dictionary<Guid, DateTime> Starts, DateTime? Now)> StartsAsync(SqlConnection? connection, string prologue, string probe, List<LiveProbeError> errors, int[]? tables,
        CancellationToken token)
    {
        var (results, failed) = await Reader.ReadAsync(connection, prologue, [AgentSql.Activities, AgentSql.ServerClock], NoValues, token).ConfigureAwait(false);
        foreach (var error in failed) errors.Add(Error(probe, error) with { Tables = tables });
        var starts = new Dictionary<Guid, DateTime>();
        if (results.TryGetValue(AgentSql.Activities.Id, out var activity))
            foreach (var row in activity.Rows)
                if (activity.Value(row, "job_id") is Guid id && activity.Value(row, "start_execution_date") is DateTime start && activity.Value(row, "stop_execution_date") is null)
                    starts[id] = start;
        DateTime? now = results.TryGetValue(AgentSql.ServerClock.Id, out var clock) && clock.Rows.Count > 0 && clock.Value(clock.Rows[0], "server_now") is DateTime time ? time : null;
        return (starts, now);
    }

    private LiveRow Row(Job job, TimeSpan? elapsed)
    {
        var status = Label(catalog.ExecutionStatuses, job.Status) ?? job.Status.ToString(CultureInfo.InvariantCulture);
        var step = job.IsRunning && job.Step is { } at
            ? "Step " + at.ToString(CultureInfo.InvariantCulture) + (job.Steps > 0 ? " of " + job.Steps.ToString(CultureInfo.InvariantCulture) : "") + (job.StepName is { Length: > 0 } name ? " · " + name : "")
                + (job.Status == 3 && job.RetryAttempt > 0 ? " (attempt " + job.RetryAttempt.ToString(CultureInfo.InvariantCulture) + ")" : "")
            : null;
        var tone = job.IsRunning ? (job.Status == 3 ? "warning" : "running") : job.LastOutcome == 0 ? "error" : !job.Enabled ? "muted" : null;
        return new LiveRow([
            LiveCell.Of(job.Name), LiveCell.Of(job.Enabled ? "Yes" : "No"), LiveCell.Of(status), LiveCell.Of(step),
            LiveCell.Of(Label(catalog.LastRunOutcomes, job.LastOutcome) ?? "Unknown"), Time(job.LastRun),
            elapsed is { } span && span >= TimeSpan.Zero ? new LiveCell((long)span.TotalSeconds, Duration((long)span.TotalSeconds)) : LiveCell.Null,
            Time(job.NextRun), LiveCell.Of(job.Category), LiveCell.Of(job.Steps > 0 ? "Yes" : "No"), LiveCell.Of(job.Schedules > 0 ? "Yes" : "No"), LiveCell.Of(job.Owner),
            LiveCell.Of(job.Id), LiveCell.Of(job.Created), tone is null ? LiveCell.Null : LiveCell.Of(tone)
        ]);
    }

    /// <summary>The list's columns by id, as the catalogue declares them (src/shared/live/catalog.ts agent.jobs.list).</summary>
    internal static readonly string[] Columns = ["name", "enabled", "status", "step", "lastOutcome", "lastRun", "elapsed", "nextRun", "category", "runnable", "scheduled", "owner", "jobId", "created", "tone"];
    private static int Column(string id) => Array.IndexOf(Columns, id);

    private bool InView(string? view, LiveRow row) => view switch
    {
        null => true,
        "running" => row.Cells[Column("tone")].Text is "running" or "warning",
        "failed" => row.Cells[Column("lastOutcome")].Text == Label(catalog.LastRunOutcomes, 0),
        "disabled" => row.Cells[Column("enabled")].Text == "No",
        _ => true
    };

    /// <summary>Column value filters (the results grid's funnels over the facets): a row passes every column's filter.</summary>
    internal static bool Passes(IEnumerable<AgentJobColumnFilterDto> filters, LiveRow row)
    {
        foreach (var filter in filters)
        {
            var value = row.Cells[Column(filter.Column!)].Text;
            var blank = string.IsNullOrEmpty(value);
            var values = filter.Values ?? [];
            if (!(blank ? filter.Blanks == true : filter.Exclude == true ? !values.Contains(value) : filter.NonBlanks == true || values.Contains(value))) return false;
        }
        return true;
    }

    /// <summary>The last finished run of a job, from its history: its job outcome row (step 0, the run's highest instance_id, whose
    /// start is the run's) and the step rows Agent wrote after the previous outcome row that started at or after this run's start.
    /// More counts what it leaves out: older steps past the table's cap, and, when the capped read stopped before the previous
    /// outcome row (or before any), the rows it could not see, so the table says it is truncated rather than complete or empty.</summary>
    internal (List<LiveRow> Rows, long More) LastRun(AgentResult history)
    {
        var rows = history.Rows.Select(row => new HistoryRow(
            Convert.ToInt32(history.Value(row, "instance_id"), CultureInfo.InvariantCulture), Convert.ToInt32(history.Value(row, "step_id"), CultureInfo.InvariantCulture),
            history.Value(row, "step_name") as string, Convert.ToInt32(history.Value(row, "run_status"), CultureInfo.InvariantCulture),
            When(Int(history.Value(row, "run_date")), Int(history.Value(row, "run_time"))), Int(history.Value(row, "run_duration")), history.Value(row, "message") as string)).ToList();
        var outcomes = rows.Where(row => row.Step == 0).OrderByDescending(row => row.Instance).ToList();
        if (outcomes.Count == 0) return ([], history.Truncated ? 1 : 0);
        var last = outcomes[0];
        var previous = outcomes.Count > 1 ? outcomes[1].Instance : 0;
        // The table keeps its first rowCap rows: a run with more steps than that keeps its newest, so the outcome row always shows.
        var cap = LiveCatalog.Current.Probes[ListProbe].Tables[1].RowCap is > 1 and var rowCap ? rowCap : int.MaxValue;
        var all = rows.Where(row => row.Step > 0 && row.Instance > previous && row.Instance < last.Instance && (last.Started is null || row.Started is null || row.Started >= last.Started)).ToList();
        var steps = all.OrderByDescending(row => row.Instance).Take(cap - 1).OrderBy(row => row.Instance).ToList();
        long more = all.Count - steps.Count + (history.Truncated && outcomes.Count == 1 ? 1 : 0);
        var maxChars = (int)catalog.Limit("gridMessageChars");
        return ([.. steps.Append(last).Select(row => new LiveRow([
            LiveCell.Of((long)row.Instance), LiveCell.Of((long)row.Step), LiveCell.Of(row.Step == 0 ? "(Job outcome)" : row.Name),
            LiveCell.Of(Label(catalog.RunStatuses, row.Status) ?? row.Status.ToString(CultureInfo.InvariantCulture)), Time(row.Started),
            DecodeDuration(row.Duration) is { } seconds ? new LiveCell(seconds, Duration(seconds)) : LiveCell.Null,
            LiveCell.Of(row.Message is { } message && message.Length > maxChars ? message[..(maxChars - 1)] + "…" : row.Message),
            catalog.RunStatusTones.TryGetValue(row.Status, out var tone) ? LiveCell.Of(tone) : LiveCell.Null
        ]))], more);
    }

    private sealed record HistoryRow(int Instance, int Step, string? Name, int Status, DateTime? Started, int? Duration, string? Message);

    // --- agent.jobs.service ------------------------------------------------------------------------------------------

    private async Task<LiveReaderSample> ServiceAsync(SqlConnection connection, string prologue, Func<string, string, string>? testText, CancellationToken token)
    {
        (int? Xps, int? State, int? Startup) read;
        if (TestService is { } test) read = test();
        else
        {
            await using var command = connection.CreateCommand();
            command.CommandTimeout = 0;
            var text = prologue + LiveSql.AgentServiceAt(band);
            command.CommandText = testText?.Invoke(ServiceProbe, text) ?? text;
            await using var reader = await command.ExecuteReaderAsync(CommandBehavior.SingleRow, token).ConfigureAwait(false);
            if (!await reader.ReadAsync(token).ConfigureAwait(false)) throw new InvalidOperationException("The Agent state read returned no row.");
            int? Number(int ordinal) => reader.IsDBNull(ordinal) ? null : Convert.ToInt32(reader.GetValue(ordinal), CultureInfo.InvariantCulture);
            read = (Number(0), Number(1), Number(2));
        }
        var status = new List<LiveStatus>();
        if (read.Xps is { } xps) status.Add(new("agentXps", (long)xps));
        if (read.State is { } state) status.Add(new("serviceState", (long)state));
        if (read.Startup is { } startup) status.Add(new("startupType", (long)startup));
        return new(null, [], [], Status: status);
    }

    // --- agent.jobs.watched ------------------------------------------------------------------------------------------

    private async Task<LiveReaderSample> WatchedAsync(SqlConnection? connection, string prologue, AgentJobsLiveArgs now, CancellationToken token)
    {
        var slots = (int)catalog.Limit("watchedJobs");
        // The slots, then the server's clock (yyyymmddhhmmss, server local time): the renderer dates a Start in server time by it.
        var values = new double?[slots * WatchedFields.Length + 1];
        var errors = new List<LiveProbeError>();
        var watched = (now.Watch ?? []).Select(id => Guid.TryParse(id, out var guid) ? guid : Guid.Empty).ToList();
        var jobs = new Job?[watched.Count];
        for (var slot = 0; slot < watched.Count && slot < slots; slot++)
        {
            var id = watched[slot];
            var (results, failed) = await Reader.ReadAsync(connection, prologue, [AgentSql.WatchedJob], (_, _) => id, token).ConfigureAwait(false);
            if (results.TryGetValue(AgentSql.WatchedJob.Id, out var job) && job.Rows.Count > 0) jobs[slot] = Job.Of(job, job.Rows[0]);
            // A job deleted since (14262, NOT_FOUND) reads status -1 (GoneStatus); any other refusal leaves its slot empty, read
            // again next sample, and is said once.
            else if (failed.Count > 0 && failed[0].Code == "NOT_FOUND") values[slot * WatchedFields.Length] = GoneStatus;
            else if (failed.Count > 0 && errors.Count == 0) errors.Add(Error(WatchedProbe, failed[0]));
        }
        Dictionary<Guid, DateTime> starts = [];
        DateTime? serverNow = null;
        if (jobs.Any(job => job?.IsRunning == true)) (starts, serverNow) = await StartsAsync(connection, prologue, WatchedProbe, errors, null, token).ConfigureAwait(false);
        if (serverNow is null && jobs.Any(job => job is not null))
        {
            // A refused clock read leaves the series empty: the renderer then counts any newer run, as before it had the clock.
            var (clock, _) = await Reader.ReadAsync(connection, prologue, [AgentSql.ServerClock], NoValues, token).ConfigureAwait(false);
            if (clock.TryGetValue(AgentSql.ServerClock.Id, out var read) && read.Rows.Count > 0 && read.Value(read.Rows[0], "server_now") is DateTime time) serverNow = time;
        }
        values[^1] = serverNow is { } stamp ? Stamp(stamp) : null;
        for (var slot = 0; slot < jobs.Length; slot++)
        {
            if (jobs[slot] is not { } job) continue;
            var at = slot * WatchedFields.Length;
            values[at] = job.Status;
            values[at + 1] = job.IsRunning ? job.Step : null;
            values[at + 2] = job.Steps;
            values[at + 3] = job.IsRunning && starts.TryGetValue(job.Id, out var start) ? Stamp(start) : null;
            values[at + 4] = job.LastOutcome;
            values[at + 5] = job.LastRun is { } last ? Stamp(last) : 0;
        }
        return new(new LiveRawSample(null, null, values, new double?[values.Length]), [], errors);
    }

    // --- Helpers -----------------------------------------------------------------------------------------------------

    private sealed record Job(Guid Id, string? Name, bool Enabled, string? Category, string? Owner, string Created, DateTime? LastRun, int LastOutcome, DateTime? NextRun, int Status,
        int? Step, string? StepName, int Steps, int Schedules, int RetryAttempt)
    {
        public bool IsRunning => Running.Contains(Status);

        public static Job Of(AgentResult result, object?[] row)
        {
            var (step, name) = ParseStep(result.Value(row, "current_execution_step") as string);
            return new((Guid)result.Value(row, "job_id")!, result.Value(row, "name") as string, Int(result.Value(row, "enabled")) == 1, result.Value(row, "category") as string,
                result.Value(row, "owner") as string,
                result.Value(row, "date_created") is DateTime created ? created.ToString("yyyy-MM-dd'T'HH:mm:ss", CultureInfo.InvariantCulture) : "",
                When(Int(result.Value(row, "last_run_date")), Int(result.Value(row, "last_run_time"))), Int(result.Value(row, "last_run_outcome")) ?? 5,
                When(Int(result.Value(row, "next_run_date")), Int(result.Value(row, "next_run_time"))), Int(result.Value(row, "current_execution_status")) ?? 4,
                step, name, Int(result.Value(row, "has_step")) ?? 0, Int(result.Value(row, "has_schedule")) ?? 0, Int(result.Value(row, "current_retry_attempt")) ?? 0);
        }
    }

    /// <summary>`current_execution_step` reads "2 (Rebuild)", or "0 (unknown)" while idle: the step number and its name.</summary>
    internal static (int? Step, string? Name) ParseStep(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return (null, null);
        var space = text.IndexOf(' ', StringComparison.Ordinal);
        var number = space < 0 ? text : text[..space];
        if (!int.TryParse(number, NumberStyles.None, CultureInfo.InvariantCulture, out var step) || step <= 0) return (null, null);
        var rest = space < 0 ? "" : text[(space + 1)..].Trim();
        var name = rest.Length >= 2 && rest[0] == '(' && rest[^1] == ')' ? rest[1..^1] : rest;
        return (step, name.Length > 0 ? name : null);
    }

    private static int? Int(object? value) => value is null or DBNull ? null : Convert.ToInt32(value, CultureInfo.InvariantCulture);

    /// <summary>msdb's yyyymmdd and hhmmss integers as a server-local time; null for 0 (never) or a value that is no date.</summary>
    internal static DateTime? When(int? date, int? time)
    {
        if (date is not { } day || day <= 0 || time is not { } clock || clock < 0) return null;
        try { return new DateTime(day / 10_000, day / 100 % 100, day % 100, clock / 10_000, clock / 100 % 100, clock % 100, DateTimeKind.Unspecified); }
        catch (ArgumentOutOfRangeException) { return null; }
    }

    /// <summary>`run_duration` (hhmmss, hours past 99 as more digits) in seconds; null when it is no duration.</summary>
    internal static long? DecodeDuration(int? value)
    {
        if (value is not { } v || v < 0) return null;
        long hours = v / 10_000, minutes = v / 100 % 100, seconds = v % 100;
        return minutes < 60 && seconds < 60 ? hours * 3600 + minutes * 60 + seconds : null;
    }

    /// <summary>SSMS's duration text: HH:MM:SS, with as many hour digits as needed.</summary>
    internal static string Duration(long seconds)
    {
        var whole = Math.Max(0, seconds);
        return (whole / 3600).ToString("00", CultureInfo.InvariantCulture) + ":" + (whole / 60 % 60).ToString("00", CultureInfo.InvariantCulture) + ":" + (whole % 60).ToString("00", CultureInfo.InvariantCulture);
    }

    /// <summary>A server-local time as yyyymmddhhmmss (exact as a double).</summary>
    internal static double Stamp(DateTime time) => time.Year * 10_000_000_000d + time.Month * 100_000_000d + time.Day * 1_000_000d + time.Hour * 10_000d + time.Minute * 100d + time.Second;

    private static LiveCell Time(DateTime? value) => value is { } time ? LiveCell.DateTime2(time, 0) : LiveCell.Null;

    private static string? Label(IReadOnlyDictionary<int, string> labels, int code) => labels.TryGetValue(code, out var label) ? label : null;

    private static LiveProbeError Error(string probe, AgentReadError error) => LiveErrors.Create(probe, error.Code, error.Message, error.Number == 0 ? null : error.Number);

    private static LiveReaderSample Failed(string probe, AgentReadError error) => new(null, [], [Error(probe, error)], Sampled: false);
}
