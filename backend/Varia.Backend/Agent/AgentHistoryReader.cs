using System.Data;
using System.Globalization;
using Microsoft.Data.SqlClient;
using Varia.Backend.Explorer;
using Varia.Backend.Live;

namespace Varia.Backend.Agent;

/// <summary>agent.history's args (src/shared/agent/history.ts agentHistoryArgsSchema): the checked jobs (null: every job; empty: none), the date
/// window in days, a run outcome, a message text, a step id and the selected run.</summary>
internal sealed record AgentHistoryLiveArgs(string[]? Jobs = null, int? Days = null, string? Outcome = null, string? Text = null, int? Step = null, AgentHistoryRunDto? Run = null);
internal sealed record AgentHistoryRunDto(string? Job, int Instance);

/// <summary>Checks agent.history's args as main's schema does.</summary>
internal static class AgentHistoryArgs
{
    public static readonly string[] Outcomes = ["failed", "succeeded", "retry", "canceled", "inProgress", "unknown"];
    public const int MaxDays = 3650;
    public const int MaxStep = 1000;

    public static AgentHistoryLiveArgs Check(AgentHistoryLiveArgs args, AgentCatalog catalog)
    {
        static RequestException Invalid(string message) => new("INVALID_PARAMS", message);
        if (args.Jobs is { } jobs && (jobs.Length > catalog.Limit("historyJobs") || jobs.Any(id => !IsUuid(id))
            || jobs.Select(id => id!.ToLowerInvariant()).Distinct(StringComparer.Ordinal).Count() != jobs.Length))
            throw Invalid("Jobs names up to " + catalog.Limit("historyJobs") + " jobs once each.");
        if (args.Days is { } days && (days < 1 || days > MaxDays)) throw Invalid("The window is 1 to " + MaxDays + " days.");
        if (args.Outcome is { } outcome && !Outcomes.Contains(outcome)) throw Invalid("The outcome is not one the viewer filters by.");
        if (args.Text is { } text && (text.Length == 0 || text.Length > catalog.Limit("searchChars"))) throw Invalid("The message text is 1 to " + catalog.Limit("searchChars") + " characters.");
        if (args.Step is { } step && (step < 0 || step > MaxStep)) throw Invalid("The step is 0 to " + MaxStep + ".");
        if (args.Run is { } run && (!IsUuid(run.Job) || run.Instance < 1)) throw Invalid("The run names a job id and an instance.");
        return args;
    }

    private static bool IsUuid(string? value) => value is { Length: 36 } && Guid.TryParseExact(value, "D", out _);
}

/// <summary>One sysjobhistory row as sp_help_jobhistory returns it.</summary>
internal sealed record AgentHistoryRow(int Instance, Guid Job, int Step, string? StepName, int? MessageId, int? Severity, string? Message, int Status, DateTime? Started, int? Duration, int? Retries);

/// <summary>What a job is doing now, for grouping its newest step rows: running (an execution status that counts as running) and, where readable,
/// its current execution's start.</summary>
internal sealed record AgentHistoryJobState(bool Running, DateTime? Start);

/// <summary>How step rows with no job outcome row read when their job is not seen running.</summary>
internal enum AgentOrphanLabel { Unknown, XpsOff }

/// <summary>One run: its job outcome row (null for step rows with none), its step rows in instance order, and its outcome. BeforeRead marks step
/// rows with no outcome row older than any of their job's outcome rows in a date-window read: their outcome row may predate the read.</summary>
internal sealed record AgentHistoryRun(Guid Job, AgentHistoryRow? Outcome, List<AgentHistoryRow> Steps, string OutcomeId, bool BeforeRead = false)
{
    /// <summary>Its outcome row's instance_id (Agent writes it last), else its first step row's, which stays the same while a running job writes
    /// more steps, so a selected In progress run stays selected until its outcome row lands.</summary>
    public int Key => Outcome?.Instance ?? Steps.Min(row => row.Instance);
    public DateTime? Started => Outcome?.Started ?? Steps.Select(row => row.Started).Where(time => time is not null).Min();
    public IEnumerable<AgentHistoryRow> Rows => Outcome is null ? Steps : Steps.Prepend(Outcome);
}

/// <summary>
/// The agent.history live source (docs/sql-server-agent.md, Log File Viewer): its one probe reads the checked jobs' history through msdb's own
/// procedures by <see cref="AgentReader"/> (so every Agent role reads what msdb shows it) and groups it into runs (<see cref="Group"/>). Table 0 is
/// the runs that pass the filters, newest first; table 1 the selected run's rows; table 2 every job the login may see, the viewer's sources. A new
/// date window or job list reads again; any other change of args regroups the last read in memory. A refused part is a value: the jobs read failing
/// fails the probe; the history read failing leaves the runs and steps empty with its error; the running state or the caps failing leave only
/// their part out. Nothing is logged.
/// </summary>
internal sealed class AgentHistoryReader(AgentHistoryLiveArgs? args = null, AgentCatalog? catalog = null) : ILiveSqlReader
{
    public const string Source = "agent.history";
    public const string ListProbe = "agent.history.list";
    private static readonly int[] Running = [1, 2, 3, 7];
    public const string InProgressLabel = "In progress";
    public const string UnknownLabel = "Unknown (no job outcome)";
    public const string XpsOffLabel = "In progress or unknown (Agent XPs off)";
    public const string InProgressMessage = "The run has no job outcome row yet: the job is running.";
    public const string UnknownMessage = "No job outcome row was written: SQL Server Agent stopped or restarted during the run.";
    public const string UnknownBeforeReadMessage = "No job outcome row was read: the run started before the history read (a day before the window), so its outcome row may be older, or SQL Server Agent stopped during it. A wider window reads it.";
    public const string XpsOffMessage = "No job outcome row yet. The Agent XPs option is 0, so whether the job is still running cannot be read.";
    public const string OutcomeStepName = "(Job outcome)";

    private readonly AgentCatalog catalog = catalog ?? AgentCatalog.Current;
    private readonly Lock gate = new();
    private AgentHistoryLiveArgs current = args ?? new();
    private bool regroup;
    private Read? last;
    private (long? Rows, long? PerJob)? caps;
    private int band = LiveSql.MaxBand;

    /// <summary>The reader the probe runs its statements through (offline checks give one with a TestRun).</summary>
    internal AgentReader Reader { get; init; } = new();
    /// <summary>Reads Agent XPs and the service state in place of the server (offline checks only).</summary>
    internal Func<(int? Xps, int? State)>? TestService { get; init; }

    /// <summary>One read of the server: the jobs, their states, the history rows, whether the read was cut, and when.</summary>
    private sealed record Read(string Key, List<Job> Jobs, Dictionary<Guid, AgentHistoryJobState> States, List<AgentHistoryRow>? Rows, bool Truncated, AgentReadError? HistoryError,
        DateTime? ServerNow, AgentOrphanLabel Label, List<LiveProbeError> Errors, int Skipped = 0);

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
        return null;
    }

    public void Apply(object value)
    {
        lock (gate)
        {
            var next = (AgentHistoryLiveArgs)value;
            // Only the job list and the window change what the server is asked; the rest regroups the last read.
            regroup = last is not null && ReadKey(next) == ReadKey(current);
            current = next;
        }
    }

    public void Reset()
    {
        lock (gate) { last = null; caps = null; regroup = false; }
    }

    /// <summary>The args in force (the checks read them).</summary>
    internal AgentHistoryLiveArgs Current { get { lock (gate) return current; } }

    private static string ReadKey(AgentHistoryLiveArgs args) =>
        (args.Jobs is null ? "*" : string.Join(",", args.Jobs.Select(id => id.ToLowerInvariant()).Order(StringComparer.Ordinal))) + "|" + args.Days?.ToString(CultureInfo.InvariantCulture);

    public async Task<LiveReaderSample> ReadAsync(SqlConnection connection, string prologue, LiveDue item, Func<string, string, string>? testText, CancellationToken token)
    {
        if (item.Probe.Spec.Id != ListProbe) throw new RequestException("BACKEND_ERROR", "agent.history has no such probe.");
        AgentHistoryLiveArgs now;
        Read? cached;
        lock (gate)
        {
            now = current;
            cached = regroup ? last : null;
            regroup = false;
        }
        var read = cached is not null && cached.Key == ReadKey(now) ? cached : await ReadServerAsync(connection, prologue, now, testText, token).ConfigureAwait(false);
        if (read is null) return failedSample!;
        lock (gate) last = read;
        return Build(read, now);
    }

    private LiveReaderSample? failedSample;

    private async Task<Read?> ReadServerAsync(SqlConnection? connection, string prologue, AgentHistoryLiveArgs now, Func<string, string, string>? testText, CancellationToken token)
    {
        var errors = new List<LiveProbeError>();
        var (results, failed) = await Reader.ReadAsync(connection, prologue, [AgentSql.JobActivity], NoValues, token).ConfigureAwait(false);
        if (!results.TryGetValue(AgentSql.JobActivity.Id, out var jobRead))
        {
            failedSample = new(null, [], [Error(failed[0])], Sampled: false);
            return null;
        }
        var jobs = jobRead.Rows.Select(row => Job.Of(jobRead, row)).ToList();
        var checkedJobs = now.Jobs?.Select(Guid.Parse).ToHashSet();
        // The running jobs' starts (and the server's clock, which the window also needs) only when they matter.
        var states = jobs.ToDictionary(job => job.Id, job => new AgentHistoryJobState(job.IsRunning, null));
        DateTime? serverNow = null;
        var running = jobs.Where(job => job.IsRunning && (checkedJobs is null || checkedJobs.Contains(job.Id))).ToList();
        if (running.Count > 0 || now.Days is not null)
        {
            var statements = running.Count > 0 ? new[] { AgentSql.Activities, AgentSql.ServerClock } : [AgentSql.ServerClock];
            var (clock, refused) = await Reader.ReadAsync(connection, prologue, statements, NoValues, token).ConfigureAwait(false);
            foreach (var error in refused) errors.Add(Error(error) with { Tables = [0] });
            if (clock.TryGetValue(AgentSql.Activities.Id, out var activity))
                foreach (var row in activity.Rows)
                    if (activity.Value(row, "job_id") is Guid id && activity.Value(row, "start_execution_date") is DateTime start && activity.Value(row, "stop_execution_date") is null && states.TryGetValue(id, out var state))
                        // run_date/run_time are whole seconds: a start with milliseconds would put the run's first step before it.
                        states[id] = state with { Start = start.AddTicks(-(start.Ticks % TimeSpan.TicksPerSecond)) };
            if (clock.TryGetValue(AgentSql.ServerClock.Id, out var time) && time.Rows.Count > 0 && time.Value(time.Rows[0], "server_now") is DateTime stamp) serverNow = stamp;
        }
        // The history caps change rarely: read once per connection (every Agent role may run sp_get_sqlagent_properties; 15281 while Agent XPs
        // is off leaves them unread until a later sample).
        if (caps is null)
        {
            var (properties, _) = await Reader.ReadAsync(connection, prologue, [AgentSql.Properties], NoValues, token).ConfigureAwait(false);
            if (properties.TryGetValue(AgentSql.Properties.Id, out var read) && read.Rows.Count > 0)
                caps = (Long(read.Value(read.Rows[0], "jobhistory_max_rows")), Long(read.Value(read.Rows[0], "jobhistory_max_rows_per_job")));
        }
        List<AgentHistoryRow>? rows = null;
        var truncated = false;
        var skipped = 0;
        AgentReadError? historyError = null;
        if (checkedJobs is null)
        {
            var statement = now.Days is null ? AgentSql.HistoryAll : AgentSql.HistoryAllSince;
            var (history, refused) = await Reader.ReadAsync(connection, prologue, [statement], (_, parameter) => parameter.Name == "@days" ? now.Days : null, token).ConfigureAwait(false);
            if (history.TryGetValue(statement.Id, out var result))
            {
                rows = [.. Rows(result)];
                truncated = result.Truncated;
            }
            else historyError = refused[0];
        }
        else if (checkedJobs.Count > 0)
        {
            // Each checked job is read by its id, so other jobs' rows never use up the cap; once the checked jobs' rows reach it, the
            // jobs not yet read are left out and counted (each read holds at most the cap, so a sample holds a few caps at most). By @job_id msdb answers a multi-server job with its target servers (NULL
            // instance and step), so those jobs' history comes from the every-job read instead.
            var statement = now.Days is null ? AgentSql.History : AgentSql.HistorySince;
            var cap = catalog.Limit("historyRows");
            var distributed = new HashSet<Guid>();
            var ordered = checkedJobs.Order().ToList();
            rows = [];
            for (var index = 0; index < ordered.Count; index++)
            {
                var one = ordered[index];
                if (rows.Count >= cap) { truncated = true; skipped = ordered.Count - index; break; }
                var (history, refused) = await Reader.ReadAsync(connection, prologue, [statement],
                    (_, parameter) => parameter.Name == "@job_id" ? one : parameter.Name == "@days" ? now.Days : null, token).ConfigureAwait(false);
                // A checked job deleted since, or no longer the login's (14262, NOT_FOUND), has no history to show: the other jobs' still read.
                if (!history.TryGetValue(statement.Id, out var result))
                {
                    if (refused[0].Code == "NOT_FOUND") continue;
                    historyError = refused[0]; rows = null; break;
                }
                if (Distributed(result)) { distributed.Add(one); continue; }
                rows.AddRange(Rows(result).Where(row => row.Job == one));
                truncated |= result.Truncated;
            }
            if (rows is not null && distributed.Count > 0)
            {
                var every = now.Days is null ? AgentSql.HistoryAll : AgentSql.HistoryAllSince;
                var (history, refused) = await Reader.ReadAsync(connection, prologue, [every], (_, parameter) => parameter.Name == "@days" ? now.Days : null, token).ConfigureAwait(false);
                if (history.TryGetValue(every.Id, out var result))
                {
                    rows.AddRange(Rows(result).Where(row => distributed.Contains(row.Job)));
                    truncated |= result.Truncated;
                }
                else { historyError = refused[0]; rows = null; }
            }
        }
        // Step rows with no outcome row of a job that is not running read Unknown, unless Agent XPs is off with the service not read as stopped:
        // then sp_help_job reports every job idle and whether the job still runs cannot be read.
        var label = AgentOrphanLabel.Unknown;
        if (rows is not null && rows.Any(row => row.Step > 0))
        {
            var (xps, state) = TestService?.Invoke() ?? await ServiceAsync(connection!, prologue, testText, token).ConfigureAwait(false);
            if (xps == 0 && state != 1) label = AgentOrphanLabel.XpsOff;
        }
        return new(ReadKey(now), jobs, states, rows, truncated, historyError, serverNow, label, errors, skipped);
    }

    /// <summary>Agent XPs and the service's state (1 stopped), as agent.jobs.service reads them; a failed read is unknown, not an error.</summary>
    private async Task<(int? Xps, int? State)> ServiceAsync(SqlConnection connection, string prologue, Func<string, string, string>? testText, CancellationToken token)
    {
        try
        {
            await using var command = connection.CreateCommand();
            command.CommandTimeout = 0;
            var text = prologue + LiveSql.AgentServiceAt(band);
            command.CommandText = testText?.Invoke(ListProbe, text) ?? text;
            await using var reader = await command.ExecuteReaderAsync(CommandBehavior.SingleRow, token).ConfigureAwait(false);
            if (!await reader.ReadAsync(token).ConfigureAwait(false)) return (null, null);
            int? Number(int ordinal) => reader.IsDBNull(ordinal) ? null : Convert.ToInt32(reader.GetValue(ordinal), CultureInfo.InvariantCulture);
            return (Number(0), Number(1));
        }
        catch (SqlException error) when (!token.IsCancellationRequested && !LiveErrors.Breaks(AgentReader.Classify(AgentSql.State, error).Code)) { return (null, null); }
    }

    // --- Building the tables -------------------------------------------------------------------------------------------

    private LiveReaderSample Build(Read read, AgentHistoryLiveArgs now)
    {
        var errors = new List<LiveProbeError>(read.Errors);
        var names = read.Jobs.ToDictionary(job => job.Id, job => job.Name ?? job.Id.ToString("D"));
        var jobsTable = new LiveReaderTable(2, [.. read.Jobs.OrderBy(job => job.Name, StringComparer.CurrentCultureIgnoreCase).Select(job => new LiveRow([
            LiveCell.Of(job.Id), LiveCell.Of(job.Name), LiveCell.Of(job.Owner), LiveCell.Of(job.IsRunning ? "Yes" : "No"), LiveCell.Of(job.Enabled ? "Yes" : "No")
        ]))]);
        if (read.Rows is not { } rows)
        {
            if (read.HistoryError is { } failed) errors.Add(Error(failed) with { Tables = [0, 1] });
            return new(null, [new(0, []), new(1, []), jobsTable], errors, Status: Status(read));
        }
        var runs = Group(rows, read.States, read.Label, windowed: now.Days is not null);
        var since = now.Days is { } days && read.ServerNow is { } clock ? clock.AddDays(-days) : (DateTime?)null;
        var kept = runs.Where(run => Passes(run, now, since)).OrderByDescending(run => run.Started ?? DateTime.MinValue).ThenByDescending(run => run.Key).ToList();
        var maxChars = (int)catalog.Limit("gridMessageChars");
        // Checked jobs read one by one may hold more runs than the table keeps: the newest stay and the table says it was cut.
        var cap = (int)catalog.Limit("historyRows");
        var runRows = kept.Take(cap).Select(run => RunRow(run, names, maxChars)).ToList();
        var steps = new List<LiveRow>();
        if (now.Run is { } selected && Guid.TryParse(selected.Job, out var job) && runs.FirstOrDefault(run => run.Job == job && run.Key == selected.Instance) is { } chosen)
            steps = [.. chosen.Rows.Select(row => StepRow(row, maxChars))];
        return new(null, [new(0, runRows, read.Truncated || kept.Count > cap ? 1 : 0), new(1, steps), jobsTable], errors, Status: Status(read));
    }

    private List<LiveStatus> Status(Read read)
    {
        var status = new List<LiveStatus>();
        if (read.Skipped > 0) status.Add(new("historySkippedJobs", (long)read.Skipped));
        if (caps is { } known)
        {
            if (known.Rows is { } rows) status.Add(new("historyMaxRows", rows));
            if (known.PerJob is { } perJob) status.Add(new("historyMaxRowsPerJob", perJob));
        }
        return status;
    }

    /// <summary>Whether a run passes the filters: started in the window (a run with no start stays), the outcome (Unknown and In progress
    /// also match In progress or unknown, Agent XPs off), a message of any of its rows
    /// containing the text (case-insensitive), a row of the step.</summary>
    internal static bool Passes(AgentHistoryRun run, AgentHistoryLiveArgs args, DateTime? since) =>
        (since is null || run.Started is null || run.Started >= since)
        && (args.Outcome is null || run.OutcomeId == args.Outcome || run.OutcomeId == "xpsOff" && args.Outcome is "unknown" or "inProgress")
        && (args.Text is null || run.Rows.Any(row => row.Message?.Contains(args.Text, StringComparison.CurrentCultureIgnoreCase) == true))
        && (args.Step is null || run.Rows.Any(row => row.Step == args.Step));

    private LiveRow RunRow(AgentHistoryRun run, Dictionary<Guid, string> names, int maxChars)
    {
        var (label, message, tone) = run.OutcomeId switch
        {
            "inProgress" => (InProgressLabel, InProgressMessage, "running"),
            "unknown" when run.Outcome is null => (UnknownLabel, run.BeforeRead ? UnknownBeforeReadMessage : UnknownMessage, "warning"),
            "xpsOff" => (XpsOffLabel, XpsOffMessage, "warning"),
            _ => (Label(catalog.RunStatuses, run.Outcome!.Status) ?? run.Outcome.Status.ToString(CultureInfo.InvariantCulture), run.Outcome.Message,
                catalog.RunStatusTones.TryGetValue(run.Outcome.Status, out var outcomeTone) ? outcomeTone : null)
        };
        var duration = run.Outcome is { } outcome ? AgentJobsReader.DecodeDuration(outcome.Duration) : null;
        return new LiveRow([
            Time(run.Started), LiveCell.Of(names.TryGetValue(run.Job, out var name) ? name : run.Job.ToString("D")), LiveCell.Of(label),
            duration is { } seconds ? new LiveCell(seconds, AgentJobsReader.Duration(seconds)) : LiveCell.Null, LiveCell.Of((long)run.Steps.Count), LiveCell.Of(Cut(message, maxChars)),
            LiveCell.Of(run.Job.ToString("D") + ":" + run.Key.ToString(CultureInfo.InvariantCulture)), LiveCell.Of(run.Job), tone is null ? LiveCell.Null : LiveCell.Of(tone)
        ]);
    }

    private LiveRow StepRow(AgentHistoryRow row, int maxChars)
    {
        var duration = AgentJobsReader.DecodeDuration(row.Duration);
        return new LiveRow([
            LiveCell.Of((long)row.Step), LiveCell.Of(row.Step == 0 ? OutcomeStepName : row.StepName), LiveCell.Of(Label(catalog.RunStatuses, row.Status) ?? row.Status.ToString(CultureInfo.InvariantCulture)),
            Time(row.Started), duration is { } seconds ? new LiveCell(seconds, AgentJobsReader.Duration(seconds)) : LiveCell.Null, LiveCell.Of((long?)row.Severity), LiveCell.Of((long?)row.MessageId),
            LiveCell.Of((long?)row.Retries), LiveCell.Of(Cut(row.Message, maxChars)), LiveCell.Of((long)row.Instance), LiveCell.Of(row.Job),
            catalog.RunStatusTones.TryGetValue(row.Status, out var tone) ? LiveCell.Of(tone) : LiveCell.Null
        ]);
    }

    private static string? Cut(string? text, int max) => text is { } value && value.Length > max ? value[..(max - 1)] + "…" : text;

    // --- Grouping --------------------------------------------------------------------------------------------------------

    /// <summary>
    /// The runs in a job's history (docs/agent-plan.md › Job Activity Monitor and history). sysjobhistory has no run id: Agent writes each step's row
    /// as the step ends (one per retry attempt) and the job outcome row (step 0) last, with the run's highest instance_id and the run's start as its
    /// run_date and run_time. So a run is a job outcome row with the step rows after the job's previous outcome row that started at or after it.
    /// Step rows that match none group by the outcome rows around them: those after the job's last outcome row are In progress while the job runs
    /// (only those that started at or after its current start, where that is readable), the rest Unknown (Agent stopped or crashed mid-run) or, with
    /// <see cref="AgentOrphanLabel.XpsOff"/>, In progress or unknown. A date-window read starts a day before the window, and the window
    /// (<see cref="Passes"/>) keeps runs by their start, so a crashed run inside the window stays Unknown. With <paramref name="windowed"/>, such
    /// step rows older than every outcome row of their job read are <see cref="AgentHistoryRun.BeforeRead"/>: a run that started before the read
    /// (a long one) has its outcome row outside it, which the rows cannot tell from a crash. One pass over each job's rows, so a full read
    /// (historyRows) groups in linear time.
    /// </summary>
    internal static List<AgentHistoryRun> Group(IEnumerable<AgentHistoryRow> rows, IReadOnlyDictionary<Guid, AgentHistoryJobState> states, AgentOrphanLabel label, bool windowed = false)
    {
        var runs = new List<AgentHistoryRun>();
        foreach (var job in rows.GroupBy(row => row.Job))
        {
            // One pass in instance order: the step rows since the job's previous outcome row wait in `pending` until the next one.
            var pending = new List<AgentHistoryRow>();
            var leading = windowed;
            foreach (var row in job.OrderBy(row => row.Instance))
            {
                if (row.Step > 0) { pending.Add(row); continue; }
                var steps = pending.Where(step => row.Started is null || step.Started is null || step.Started >= row.Started).ToList();
                runs.Add(new(job.Key, row, steps, OutcomeOf(row.Status)));
                // Step rows between two outcome rows that the later one does not claim: one Unknown run per gap (a run Agent never finished).
                var gap = steps.Count == pending.Count ? [] : pending.Except(steps).ToList();
                if (gap.Count > 0) runs.Add(new(job.Key, null, gap, "unknown", leading));
                pending.Clear();
                leading = false;
            }
            if (pending.Count == 0) continue;
            var state = states.TryGetValue(job.Key, out var known) ? known : new AgentHistoryJobState(false, null);
            var unknown = label == AgentOrphanLabel.XpsOff ? "xpsOff" : "unknown";
            // After the job's last outcome row: the running job's current run, the rest left by a run that never wrote one.
            var tail = pending;
            var current = state.Running ? tail.Where(row => state.Start is not { } start || row.Started is null || row.Started >= start).ToList() : [];
            var before = tail.Except(current).ToList();
            if (before.Count > 0) runs.Add(new(job.Key, null, before, state.Running ? "unknown" : unknown, leading));
            if (current.Count > 0) runs.Add(new(job.Key, null, current, "inProgress"));
        }
        return runs;
    }

    private static string OutcomeOf(int status) => status switch { 0 => "failed", 1 => "succeeded", 2 => "retry", 3 => "canceled", 4 => "inProgress", _ => "unknown" };

    // --- Helpers ---------------------------------------------------------------------------------------------------------

    private sealed record Job(Guid Id, string? Name, string? Owner, bool Enabled, bool IsRunning)
    {
        public static Job Of(AgentResult result, object?[] row) => new((Guid)result.Value(row, "job_id")!, result.Value(row, "name") as string, result.Value(row, "owner") as string,
            Int(result.Value(row, "enabled")) == 1, Running.Contains(Int(result.Value(row, "current_execution_status")) ?? 4));
    }

    /// <summary>A result's history rows, leaving out rows with no instance or step (a multi-server job's target-server rows).</summary>
    internal static IEnumerable<AgentHistoryRow> Rows(AgentResult result) => result.Rows.Select(row => Row(result, row)).OfType<AgentHistoryRow>();
    /// <summary>Whether msdb answered with a multi-server job's target servers: rows with no instance_id.</summary>
    internal static bool Distributed(AgentResult result) => result.Rows.Any(row => result.Value(row, "instance_id") is null or DBNull);

    internal static AgentHistoryRow? Row(AgentResult result, object?[] row) => result.Value(row, "instance_id") is null or DBNull || result.Value(row, "step_id") is null or DBNull ? null : new(
        Convert.ToInt32(result.Value(row, "instance_id"), CultureInfo.InvariantCulture), (Guid)result.Value(row, "job_id")!, Convert.ToInt32(result.Value(row, "step_id"), CultureInfo.InvariantCulture),
        result.Value(row, "step_name") as string, Int(result.Value(row, "sql_message_id")), Int(result.Value(row, "sql_severity")), result.Value(row, "message") as string,
        Convert.ToInt32(result.Value(row, "run_status"), CultureInfo.InvariantCulture), AgentJobsReader.When(Int(result.Value(row, "run_date")), Int(result.Value(row, "run_time"))),
        Int(result.Value(row, "run_duration")), Int(result.Value(row, "retries_attempted")));

    private static object? NoValues(AgentStatement statement, AgentParameter parameter) => null;
    private static int? Int(object? value) => value is null or DBNull ? null : Convert.ToInt32(value, CultureInfo.InvariantCulture);
    private static long? Long(object? value) => value is null or DBNull ? null : Convert.ToInt64(value, CultureInfo.InvariantCulture);
    private static LiveCell Time(DateTime? value) => value is { } time ? LiveCell.DateTime2(time, 0) : LiveCell.Null;
    private static string? Label(IReadOnlyDictionary<int, string> labels, int code) => labels.TryGetValue(code, out var label) ? label : null;
    private static LiveProbeError Error(AgentReadError error) => LiveErrors.Create(ListProbe, error.Code, error.Message, error.Number == 0 ? null : error.Number);
}
