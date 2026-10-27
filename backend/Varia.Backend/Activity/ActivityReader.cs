using System.Data;
using System.Globalization;
using Microsoft.Data.SqlClient;
using Varia.Backend.Explorer;
using Varia.Backend.Live;

namespace Varia.Backend.Activity;

/// <summary>The Activity Monitor's live source (D-am §4): runs each probe's constant statements (ActivitySql) on the live
/// connection SqlSampler holds, one at a time, and builds the probe's series and rows in C#. The capability probe replaces the
/// live session probe, so each new connection reads what the login may do; without server state the sessions probe reads only
/// what SQL Server shows of the monitor's own session. A statement the login may not run (PERMISSION_DENIED) or the server
/// lacks (NOT_SUPPORTED) fails alone: its tables and series are named in an error beside the sample, and it is not run again
/// on that connection (no retry storm), only reported; each new connection's capability probe tries them again, since its
/// login may now hold the permission or its server have the view. Any other statement error stops the probe's batch: what
/// was read arrives, the error names the rest, and a probe that read nothing fails and backs off. A probe that needs server
/// state runs nothing without it. A lost connection or the budget is thrown for SqlSampler to handle. Nothing is logged.</summary>
internal sealed class ActivityReader : ILiveSqlReader
{
    public const string OverviewProbe = "activity.overview";
    public const string SessionsProbe = "activity.sessions";
    private readonly ActivityCatalog catalog;
    private readonly ILiveHost host;
    private readonly string connectionId;
    private readonly Lock gate = new();
    private readonly Dictionary<string, ActivityFilter> filters = new(StringComparer.Ordinal);
    private readonly ActivitySessionRows sessions;
    /// <summary>Statements that failed for good on this connection, by probe, render and statement: reported each sample, not
    /// run again until a new connection's capability probe.</summary>
    private readonly Dictionary<string, LiveProbeError> skipped = new(StringComparer.Ordinal);
    private readonly HashSet<string> statusSent = new(StringComparer.Ordinal);
    /// <summary>Per probe: the server's ms_ticks and start time at its last sample (null when not read), the schedule's time it
    /// was taken at, and the probe's sample clock then.</summary>
    private readonly Dictionary<string, (long? Ticks, long? Start, long TakenAt, long Clock)> clocks = new(StringComparer.Ordinal);
    private readonly ActivityIoTotals io = new();
    private int focus;
    private ServerProfile? profile;

    public ActivityReader(ILiveHost host, string connectionId, ActivityLiveArgs? args = null, ActivityCatalog? catalog = null)
    {
        this.host = host;
        this.connectionId = connectionId;
        this.catalog = catalog ?? ActivityCatalog.Current;
        sessions = new(this.catalog);
        if (args is not null) Apply(args);
    }

    /// <summary>What the capability probe found on the current connection (null before it ran).</summary>
    public ActivityCapabilities? Capabilities { get; private set; }

    /// <summary>Runs a statement in place of the server, with its parameter values (offline checks only).</summary>
    internal Func<ActivityStatement, IReadOnlyDictionary<string, object>, Task<ActivityResult>>? TestRun { get; init; }

    /// <summary>The filters and focus session the args set (the checks read them).</summary>
    internal (IReadOnlyDictionary<string, ActivityFilter> Filters, int Focus) Current
    {
        get { lock (gate) return (new Dictionary<string, ActivityFilter>(filters, StringComparer.Ordinal), focus); }
    }

    /// <summary>Checks args as main's schema does: at least one member, one filter per table, each a valid filter, and a session
    /// id within the catalogue's bound (0 follows none).</summary>
    public static ActivityLiveArgs Check(ActivityLiveArgs args, ActivityCatalog catalog)
    {
        static RequestException Invalid(string message) => new("INVALID_PARAMS", message);
        if (args.Filters is null && args.FocusSession is null) throw Invalid("The args change nothing.");
        if (args.FocusSession is < 0 || args.FocusSession > catalog.Limit("sessionId")) throw Invalid("The focus session is out of range.");
        if (args.Filters is { } list)
        {
            if (list.Count is 0 || list.Count > catalog.Tables.Count) throw Invalid("Name one filter per table.");
            if (list.Any(filter => filter is null)) throw Invalid("A filter cannot be null.");
            foreach (var filter in list) ActivityFilter.Compile(catalog, filter!);
            if (list.Select(filter => filter!.Table).Distinct(StringComparer.Ordinal).Count() != list.Count) throw Invalid("One filter per table.");
        }
        return args;
    }

    /// <summary>An update replaces the filters of the tables it names; a table without one shows the catalogue's defaults.</summary>
    public void Apply(object value)
    {
        var args = (ActivityLiveArgs)value;
        lock (gate)
        {
            foreach (var dto in args.Filters ?? []) filters[dto!.Table!] = ActivityFilter.Compile(catalog, dto);
            if (args.FocusSession is { } session) focus = session;
        }
    }

    public void Reset()
    {
        sessions.Reset();
        clocks.Clear();
        io.Reset();
        // The next connection may reach another server (a failover), with other views and permissions.
        skipped.Clear();
    }

    public (string Reason, string Note)? Unavailable(LiveProbeJson spec, ServerProfile profile)
    {
        this.profile = profile;
        if (catalog.Pending.TryGetValue(spec.Id, out var note)) return ("NOT_SUPPORTED", note);
        if (!catalog.LiveProbes.Contains(spec.Id) || ActivitySql.BandOf(profile.Major, profile.EngineEdition, profile.CatalogBand) is null) return ("NOT_SUPPORTED", LiveErrors.UnsupportedMessage);
        return null;
    }

    public async Task<(int Spid, bool ServerState)> SessionAsync(SqlConnection connection, string prologue, string permission, CancellationToken token)
    {
        var result = await Run(connection, prologue, ActivitySql.Capabilities, null, _ => permission, token).ConfigureAwait(false);
        if (result.Rows is not [var row, ..]) throw new InvalidOperationException("The capability probe returned no row.");
        var found = new ActivityCapabilities(result.Int(row, "spid") ?? 0, result.Int(row, "server_state") == 1, result.Int(row, "alter_any_connection") == 1,
            result.Int(row, "view_any_definition") == 1, result.Int(row, "spills") == 1);
        lock (gate)
        {
            Capabilities = found;
            // Each new connection reports what its login may do again.
            statusSent.Clear();
        }
        // What failed on the last connection runs again: the login may since hold the permission, or this be another server.
        skipped.Clear();
        return (found.Spid, found.ServerState);
    }

    public async Task<LiveReaderSample> ReadAsync(SqlConnection connection, string prologue, LiveDue item, Func<string, string, string>? testText, CancellationToken token)
    {
        var spec = item.Probe.Spec;
        var server = profile ?? throw new InvalidOperationException("The probe ran before the source opened.");
        var capabilities = Capabilities ?? throw new InvalidOperationException("The probe ran before the capability probe.");
        // The opened frame says so when the capability probe ran as the source opened; when it did not (every probe started
        // paused, the gates were full, the connect failed), the probe learns it here and stops, as it would have opened.
        if (spec.Permission == "serverState" && !capabilities.ServerState)
            return new(null, [], [LiveErrors.Create(spec.Id, "PERMISSION_DENIED", LiveErrors.PermissionMessage)], Sampled: false);
        var band = ActivitySql.BandOf(server.Major, server.EngineEdition, server.CatalogBand) ?? throw new InvalidOperationException("The probe ran on a server the monitor does not serve.");
        var render = new ActivityRender(band, catalog.EditionOf(server.EngineEdition)!, capabilities.TotalSpills, capabilities.ServerState);
        var statements = ActivitySql.Statements(spec.Id, render);
        var results = new Dictionary<string, ActivityResult>(StringComparer.Ordinal);
        var errors = new List<LiveProbeError>();
        for (var at = 0; at < statements.Count; at++)
        {
            var statement = statements[at];
            // The render is part of the key: the limited sessions statement shares its id with the full one, which may have
            // failed on a connection whose login read server state.
            var key = spec.Id + " " + statement.Id + (render.ServerState ? "" : " limited");
            if (skipped.TryGetValue(key, out var known))
            {
                errors.Add(known);
                continue;
            }
            try { results[statement.Id] = await Run(connection, prologue, statement, testText, parameter => Value(statement, parameter), token).ConfigureAwait(false); }
            catch (SqlException error) when (!token.IsCancellationRequested)
            {
                var value = LiveErrors.From(spec.Id, error);
                if (LiveErrors.Breaks(value.Code) || value.Code == "LOGIN_FAILED") throw;
                if (value.Code is "PERMISSION_DENIED" or "NOT_SUPPORTED")
                {
                    errors.Add(skipped[key] = Named(value, spec, [statement]));
                    continue;
                }
                // A lock wait or another failure: what was read arrives, and the error names the statements left unrun.
                errors.Add(Named(value, spec, statements.Skip(at)));
                break;
            }
        }
        // The sessions probe's clock moves with every read, even one that read nothing, so each row's rate spans its own time.
        var sampleTime = spec.Id == SessionsProbe ? SampleTime(spec.Id, results, item) : 0;
        if (results.Count == 0)
            return new(null, [], [errors.Count > 0 ? errors[0] with { Tables = null, Series = null } : LiveErrors.Create(spec.Id, "SQL_ERROR", "The probe read nothing.")], Sampled: false);

        if (spec.Id == OverviewProbe) return new(ActivityOverview.Raw([.. spec.Series.Select(series => series.Id)], results, catalog, io), [], errors);
        if (spec.Id != SessionsProbe) throw new InvalidOperationException("No reader for this Activity Monitor probe.");
        return Sessions(spec, sampleTime, results, errors, capabilities);
    }

    private LiveReaderSample Sessions(LiveProbeJson spec, long at, Dictionary<string, ActivityResult> results, List<LiveProbeError> errors, ActivityCapabilities capabilities)
    {
        Dictionary<string, ActivityFilter> current;
        int focusSession;
        bool sendStatus;
        lock (gate)
        {
            current = new(filters, StringComparer.Ordinal);
            focusSession = focus;
            sendStatus = statusSent.Add(spec.Id);
        }
        var (msTicks, startTicks) = ActivityOverview.Clock(results);
        var varia = new VariaSessions(catalog, Environment.ProcessId, host.Clients, host.OwnSessions(connectionId));
        var built = sessions.Build(results, at, varia, capabilities.Spid, focusSession, hideMonitor: capabilities.ServerState);
        ActivityFilter Filter(string table) => current.GetValueOrDefault(table) ?? ActivityFilter.Compile(catalog, new(table));
        var tables = new List<LiveReaderTable>();
        if (results.ContainsKey("sessions"))
        {
            var processes = Filter("sessions");
            var writer = sessions.SessionsWriter;
            tables.Add(new(Index(spec, "sessions"), built.Sessions, built.SessionsMore, row => processes.Matches(writer.Reader(row), built.Facts.GetValueOrDefault(row))));
            var chains = Filter("blocking");
            // Without the waiting tasks (no server state) the chains are unknown: the error names the table instead.
            if (results.ContainsKey("edges")) tables.Add(new(Index(spec, "blocking"), built.Blocking, built.BlockingMore, row => chains.Matches(sessions.BlockingWriter.Reader(row))));
        }
        if (built.Active is { } active)
        {
            var queries = Filter("activeQueries");
            tables.Add(new(Index(spec, "activeQueries"), active, built.ActiveMore, row => queries.Matches(sessions.ActiveWriter.Reader(row))));
        }
        if (!capabilities.ServerState)
            errors.Add(LiveErrors.Create(spec.Id, "PERMISSION_DENIED", LiveErrors.PermissionMessage) with { Tables = [Index(spec, "blocking"), Index(spec, "activeQueries")] });
        LiveStatus[]? status = sendStatus ? [new("serverState", capabilities.ServerState ? 1 : 0), new("canKill", capabilities.AlterAnyConnection ? 1 : 0)] : null;
        return new(new LiveRawSample(msTicks, startTicks, [built.FocusCpuRate, built.FocusReadsRate], [null, null]), tables, errors, Status: status);
    }

    /// <summary>The sample's time on the probe's own clock, in milliseconds: it moves by the server's clock (ms_ticks) between
    /// samples that both read it, else by the schedule's, so a slow round trip never skews a rate. Per-row baselines keep the
    /// time they were read at, so a row (or a statement) missing from a sample yields a rate over its own span when it comes
    /// back. After a baseline, a pause or a restart every row starts again.</summary>
    internal long SampleTime(string probe, IReadOnlyDictionary<string, ActivityResult> results, LiveDue item)
    {
        var (msTicks, startTicks) = ActivityOverview.Clock(results);
        var previous = clocks.TryGetValue(probe, out var known) ? known : ((long? Ticks, long? Start, long TakenAt, long Clock)?)null;
        var restarted = previous is { Start: { } started } && startTicks is { } start && start != started;
        long? step = previous is not { } before ? null : msTicks is { } now && before.Ticks is { } then ? now - then : item.TakenAt - before.TakenAt;
        if (item.Gap is "baseline" or "resumed" || restarted || step is not >= 0)
        {
            sessions.Reset();
            step = 0;
        }
        var clock = (previous?.Clock ?? 0) + step.Value;
        clocks[probe] = (msTicks, startTicks ?? previous?.Start, item.TakenAt, clock);
        return clock;
    }

    private static int Index(LiveProbeJson spec, string table) => spec.Tables.FindIndex(entry => entry.Id == table) is >= 0 and var at ? at : throw new InvalidOperationException("Unknown live table " + table);

    /// <summary>The error with the tables and series the statements feed (their indexes in the probe's catalogue entry).</summary>
    internal static LiveProbeError Named(LiveProbeError error, LiveProbeJson spec, IEnumerable<ActivityStatement> statements)
    {
        var feeds = statements.SelectMany(statement => statement.Feeds).ToHashSet(StringComparer.Ordinal);
        int[] tables = [.. spec.Tables.Select((table, at) => (table, at)).Where(entry => feeds.Contains(entry.table.Id)).Select(entry => entry.at)];
        int[] series = [.. spec.Series.Select((series, at) => (series, at)).Where(entry => feeds.Contains(entry.series.Id) || feeds.Contains("wait.*") && entry.series.Id.StartsWith("wait.", StringComparison.Ordinal)).Select(entry => entry.at)];
        return error with { Tables = tables.Length > 0 ? tables : null, Series = series.Length > 0 ? series : null };
    }

    /// <summary>A statement's parameter values: each cap is the catalogue's limit plus one, so a full result shows truncation.</summary>
    private object Value(ActivityStatement statement, ActivityParameter parameter) => (statement.Id, parameter.Name) switch
    {
        ("sessions", "@rowCap") => (int)catalog.Limit("sessions") + 1,
        ("edges", "@edgeCap") => (int)catalog.Limit("blockingEdges") + 1,
        ("activeQueries", "@take") => (int)catalog.Limit("activeQueries") + 1,
        _ => throw new RequestException("BACKEND_ERROR", "An Activity Monitor statement has a parameter the source does not fill.")
    };

    private Task<ActivityResult> Run(SqlConnection connection, string prologue, ActivityStatement statement, Func<string, string, string>? testText,
        Func<ActivityParameter, object> values, CancellationToken token) =>
        TestRun is { } run ? run(statement, statement.Parameters.ToDictionary(parameter => parameter.Name, values, StringComparer.Ordinal)) : RunAsync(connection, prologue, statement, testText, values, token);

    /// <summary>Runs one statement with the live prologue and reads its rows, checking its columns against the declaration (a
    /// mismatch is a bug, which ends the view failed, never a sample).</summary>
    private static async Task<ActivityResult> RunAsync(SqlConnection connection, string prologue, ActivityStatement statement, Func<string, string, string>? testText,
        Func<ActivityParameter, object> values, CancellationToken token)
    {
        await using var command = connection.CreateCommand();
        command.CommandTimeout = 0;
        var text = prologue + statement.Text;
        command.CommandText = testText?.Invoke(statement.Probe, text) ?? text;
        foreach (var parameter in statement.Parameters)
        {
            command.Parameters.Add(new SqlParameter(parameter.Name, parameter.Type) { Value = values(parameter), Size = parameter.Size });
        }
        await using var reader = await command.ExecuteReaderAsync(token).ConfigureAwait(false);
        if (reader.FieldCount != statement.Columns.Count || Enumerable.Range(0, reader.FieldCount).Any(at => reader.GetName(at) != statement.Columns[at]))
            throw new RequestException("BACKEND_ERROR", "An Activity Monitor statement returned other columns than it declares.");
        var rows = new List<object?[]>();
        while (await reader.ReadAsync(token).ConfigureAwait(false))
        {
            var row = new object?[reader.FieldCount];
            reader.GetValues(row!);
            for (var at = 0; at < row.Length; at++) if (row[at] is DBNull) row[at] = null;
            rows.Add(row);
        }
        return new(statement.Columns, rows);
    }
}
