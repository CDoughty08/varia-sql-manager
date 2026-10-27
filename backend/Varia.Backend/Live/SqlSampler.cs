using System.Data;
using System.Diagnostics;
using System.Globalization;
using Microsoft.Data.SqlClient;
using Varia.Backend.Explorer;

namespace Varia.Backend.Live;

/// <summary>The pool and the prologue of a live scope (docs/ipc.md, Live subscriptions). Server DMVs read on the
/// connection's " - Activity Monitor" pool in the login's own initial catalog; SSISDB reads (the SSIS sources) use the
/// " - Integration Services" pool with Initial Catalog the catalog's database (SSISDB, or the checks' fake catalog), which
/// the SSIS tree and ssis.describe share with their own prologues. Each scope's pool keeps its SET options away from query
/// tabs, Object Explorer and scripting.</summary>
internal static class LiveConnections
{
    public const string ServerSuffix = " - Activity Monitor";
    public const string SsisSuffix = " - Integration Services";

    public static (string? Database, string Suffix) Pool(string scope, string catalogDatabase) => scope switch
    {
        "server" => (null, ServerSuffix),
        "ssisdb" => (catalogDatabase, SsisSuffix),
        _ => throw new InvalidOperationException("This live scope reads no SQL Server.")
    };

    /// <summary>The live band of a server: its major version (2016 to 2025), or the newest for Managed Instance, which reports
    /// 12 while running the newest engine.</summary>
    public static int Band(ServerProfile profile) => profile.EngineEdition == 8 ? LiveSql.MaxBand : Math.Clamp(profile.Major, LiveSql.MinBand - 1, LiveSql.MaxBand);

    /// <summary>The permission that shows server state: VIEW SERVER PERFORMANCE STATE from SQL Server 2022 (which VIEW SERVER
    /// STATE implies), VIEW SERVER STATE before and on Managed Instance.</summary>
    public static string ServerStatePermission(ServerProfile profile) => profile.EngineEdition != 8 && profile.Major >= 16 ? "VIEW SERVER PERFORMANCE STATE" : "VIEW SERVER STATE";
}

/// <summary>A SQL source's probes (scope server or ssisdb): one connection from the scope's live pool, held while the
/// subscription samples so its session id is known (the Activity Monitor hides its own session by it) and returned to the
/// pool while nothing is due for a while. Every command runs with the scope's prologue (for SSISDB, READ COMMITTED when the
/// catalog's database has READ_COMMITTED_SNAPSHOT on, as the session probe reads), under a live gate, within the probe's
/// budget (a cancellation token: CommandTimeout is 0), and reads one row whose columns LiveSql declares (checked on every
/// read); LiveDeltas turns its series into the sample, and its status columns are sent as they are. Connecting takes no gate, so a server that stopped answering never holds one that views on other
/// servers need, and has its own bound (15 s), since a profile's Connect Timeout may be 0 (none). Failures are values: a lock
/// wait (BLOCKED), the budget or the connect bound (TIMEOUT), a lost connection (reopened on the next due tick under
/// back-off), a sign-in that fails, a permission error (terminal). The constructor acquires nothing; OpenAsync connects once
/// to read the session id and the permission (unless every probe starts paused: no SQL while paused), and a failure there is
/// reported by the first tick instead. An SSISDB source whose connection cannot open the catalog's database reads why on a
/// connection in the login's own database: no catalog (CATALOG_MISSING, terminal), one that is unavailable (retried) or one
/// the login may not open (PERMISSION_DENIED).</summary>
internal sealed class SqlSampler(ILiveHost host, LiveGates gates, string connectionId, LiveSourceJson source, Func<string, string, string>? testText) : ILiveSampler
{
    /// <summary>The session probe's own budget (D-live: 2 s for the permission probe).</summary>
    private const int SessionBudgetMs = 2000;
    private readonly Dictionary<string, LiveDeltas> deltas = new(StringComparer.Ordinal);
    private readonly Dictionary<string, long> lastAt = new(StringComparer.Ordinal);
    private readonly Dictionary<string, LiveQuery> queries = new(StringComparer.Ordinal);
    private readonly bool ssisdb = source.Scope == "ssisdb";
    /// <summary>The scope's prologue: an SSISDB source's follows the catalog's READ_COMMITTED_SNAPSHOT, read with the session.</summary>
    private string prologue = LiveSql.Prologue(source.Scope, readCommittedSnapshot: false);
    private SqlConnection? connection;
    /// <summary>The session probe ran on the open connection (it waits for a gate, so a connection can open without it).</summary>
    private bool sessionRead;
    private string permission = "VIEW SERVER STATE";
    /// <summary>An SSISDB source's login is sysadmin or in ssis_admin (read with the session): it may read catalog_properties.</summary>
    private bool admin;
    private int band;
    private int? spid;
    /// <summary>The session that the next tick reports: set when a connection opens after the opened frame.</summary>
    private int? reopenedSpid;
    private bool opened;

    /// <summary>How long a live connect may take before it is a TIMEOUT value (the checks shorten it).</summary>
    internal int ConnectBudgetMs { get; init; } = 15_000;
    public int? PeriodMs => null;
    public bool Ended => false;

    public async Task<LiveOpening> OpenAsync(IReadOnlyList<LiveProbeState> probes, IReadOnlyList<LiveCursor> resume, CancellationToken token)
    {
        var profile = host.Profile(connectionId) ?? throw new RequestException("NOT_CONNECTED", "Connect to a SQL Server first.");
        band = LiveConnections.Band(profile);
        permission = LiveConnections.ServerStatePermission(profile);
        bool? permitted = null;
        // A view subscribed hidden runs no SQL until a probe resumes; its first sample connects and reads the session then.
        if (!probes.All(probe => probe.Paused))
        {
            try
            {
                await ConnectAsync(token).ConfigureAwait(false);
                // The session probe is a live statement too; with the gates full, the first tick reads it instead.
                using var lease = await gates.WaitAsync(connectionId, SessionBudgetMs, token).ConfigureAwait(false);
                if (lease is not null) permitted = await SessionAsync(token).ConfigureAwait(false);
            }
            catch (SqlException) { Drop(); }
            catch (InvalidOperationException) { Drop(); }
            catch (TimeoutException) { Drop(); }
            catch (RequestException error) when (error.Code is "AUTH_KERBEROS" or "AUTH_UNSUPPORTED" or "AUTH_ENTRA") { Drop(); }
        }
        opened = true;
        var states = new List<LiveOpenedProbe>();
        foreach (var probe in probes)
        {
            var spec = probe.Spec;
            var gated = spec.Gates is { } gates && (band < gates.MinMajor || !gates.Editions.Contains(profile.EngineEdition));
            var query = gated ? null : LiveSql.For(spec.Id, band);
            if (query is not null) queries[spec.Id] = query;
            deltas[spec.Id] = new([.. spec.Series.Select(series => series.Counter)]);
            LiveOpenedProbe State(string state, string? reason = null, string? note = null) => new(spec.Id, probe.IntervalMs, spec.IntervalMs.Min, spec.IntervalMs.Max, state, reason, note);
            states.Add(query is null ? State("unavailable", "NOT_SUPPORTED", LiveErrors.UnsupportedMessage)
                : spec.Permission == "serverState" && permitted is false ? State("unavailable", "PERMISSION_DENIED", LiveErrors.PermissionMessage)
                : State("ok"));
        }
        return new(states, band, spid, LiveSql.Isolation(prologue));
    }

    /// <summary>Opens a connection when none is open, within <see cref="ConnectBudgetMs"/> (TimeoutException past it).</summary>
    private async Task ConnectAsync(CancellationToken token)
    {
        if (connection is { State: ConnectionState.Open }) return;
        Drop();
        var (database, suffix) = LiveConnections.Pool(source.Scope, host.SsisCatalog);
        var opening = host.PoolConnection(connectionId, database, suffix);
        connection = opening;
        sessionRead = false;
        using var bound = CancellationTokenSource.CreateLinkedTokenSource(token);
        bound.CancelAfter(ConnectBudgetMs);
        try { await host.OpenAsync(opening, bound.Token).ConfigureAwait(false); }
        catch (Exception error) when (bound.IsCancellationRequested && !token.IsCancellationRequested && error is SqlException or InvalidOperationException or OperationCanceledException)
        {
            throw new TimeoutException("The connect took longer than its bound.");
        }
    }

    /// <summary>Reads the open connection's session id and whether the login may read server state.</summary>
    private async Task<bool> SessionAsync(CancellationToken token)
    {
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(token);
        budget.CancelAfter(SessionBudgetMs);
        int session;
        bool allowed;
        try
        {
            await using var command = connection!.CreateCommand();
            command.CommandTimeout = 0;
            command.CommandText = prologue + LiveSql.Session;
            command.Parameters.Add(new SqlParameter("@permission", SqlDbType.NVarChar, 128) { Value = permission });
            command.Parameters.Add(new SqlParameter("@catalog", SqlDbType.NVarChar, 128) { Value = ssisdb ? host.SsisCatalog : DBNull.Value });
            await using var reader = await command.ExecuteReaderAsync(budget.Token).ConfigureAwait(false);
            if (!await reader.ReadAsync(budget.Token).ConfigureAwait(false)) throw new InvalidOperationException("The session probe returned no row.");
            session = Convert.ToInt32(reader.GetValue(0), CultureInfo.InvariantCulture);
            allowed = Convert.ToInt32(reader.GetValue(1), CultureInfo.InvariantCulture) == 1;
            if (ssisdb) prologue = LiveSql.Prologue(source.Scope, !reader.IsDBNull(2) && Convert.ToInt32(reader.GetValue(2), CultureInfo.InvariantCulture) == 1);
            admin = ssisdb && Convert.ToInt32(reader.GetValue(3), CultureInfo.InvariantCulture) == 1;
        }
        catch (Exception error) when (budget.IsCancellationRequested && !token.IsCancellationRequested && error is SqlException or InvalidOperationException or OperationCanceledException)
        {
            // SqlClient words its own cancel several ways; the probe's budget is what ran out.
            throw new TimeoutException("The session probe took longer than its budget.");
        }
        // Every new session after the opened frame is reported, even under the same number: SQL Server reuses a killed one's.
        if (opened) reopenedSpid = session;
        spid = session;
        sessionRead = true;
        return allowed;
    }

    public async Task<LiveSampleBatch> SampleAsync(IReadOnlyList<LiveDue> due, CancellationToken token)
    {
        var samples = new List<LiveSample>();
        var errors = new List<LiveProbeError>();
        // A connect that failed this tick: the other due probes report it rather than try again at once.
        LiveProbeError? unconnected = null;
        foreach (var item in due)
        {
            var id = item.Probe.Spec.Id;
            if (!queries.TryGetValue(id, out var query))
            {
                errors.Add(LiveErrors.Create(id, "NOT_SUPPORTED", LiveErrors.UnsupportedMessage));
                continue;
            }
            if (unconnected is not null)
            {
                errors.Add(unconnected with { Probe = id });
                continue;
            }
            var connected = false;
            LiveProbeError? failure = null;
            using var budget = CancellationTokenSource.CreateLinkedTokenSource(token);
            try
            {
                await ConnectAsync(token).ConfigureAwait(false);
                connected = true;
                using var lease = await gates.WaitAsync(connectionId, item.BudgetMs, token).ConfigureAwait(false);
                if (lease is null)
                {
                    errors.Add(LiveErrors.Create(id, "BUSY", LiveErrors.BusyMessage));
                    continue;
                }
                if (!sessionRead) await SessionAsync(token).ConfigureAwait(false);
                budget.CancelAfter(item.BudgetMs);
                var started = Stopwatch.GetTimestamp();
                var (raw, status) = await ReadAsync(query, item, budget.Token).ConfigureAwait(false);
                var cost = (int)Math.Min(int.MaxValue, Stopwatch.GetElapsedTime(started).TotalMilliseconds);
                var now = Stopwatch.GetTimestamp();
                long? clientElapsed = lastAt.TryGetValue(id, out var before) ? (long)Stopwatch.GetElapsedTime(before, now).TotalMilliseconds : null;
                lastAt[id] = now;
                var result = deltas[id].Apply(raw, clientElapsed, item.EffectiveIntervalMs, item.Gap);
                // A probe without series has no rates to start again (so no quick second sample) and sends no metrics.
                var rated = item.Probe.Spec.Series.Count > 0;
                samples.Add(new LiveSample(id, cost, item.EffectiveIntervalMs, result.ElapsedMs, rated ? result.Gap : item.Gap == "late" ? "late" : null, item.Skipped,
                    rated ? result.Values : null, Status: status));
            }
            catch (Exception error) when (token.IsCancellationRequested && error is SqlException or InvalidOperationException or OperationCanceledException)
            {
                // The subscription ended mid-statement: SqlClient reports the cancel in its own words.
                Drop();
                throw new OperationCanceledException(token);
            }
            catch (Exception error) when (error is TimeoutException || budget.IsCancellationRequested && error is SqlException or InvalidOperationException or OperationCanceledException)
            {
                Drop();
                failure = LiveErrors.Create(id, "TIMEOUT", LiveErrors.TimeoutMessage);
            }
            catch (SqlException error) when (ssisdb && !connected && LiveErrors.OpensNoDatabase(error))
            {
                Drop();
                failure = await CatalogFailureAsync(id, item.BudgetMs, token).ConfigureAwait(false) ?? LiveErrors.From(id, error);
            }
            catch (SqlException error)
            {
                failure = LiveErrors.From(id, error);
                if (ssisdb && failure.Code == "PERMISSION_DENIED") failure = failure with { Message = LiveErrors.CatalogAccessMessage };
                if (LiveErrors.Breaks(failure.Code) || connection is not { State: ConnectionState.Open }) Drop(baseline: failure.Code == "CONNECTION_LOST");
            }
            catch (InvalidOperationException)
            {
                // SqlClient's own word for a connection that broke between commands.
                Drop(baseline: true);
                failure = LiveErrors.Create(id, "CONNECTION_LOST", LiveErrors.LostMessage);
            }
            catch (RequestException error) when (error.Code is "AUTH_KERBEROS" or "AUTH_UNSUPPORTED" or "AUTH_ENTRA")
            {
                Drop();
                failure = LiveErrors.SignIn(id, error);
            }
            if (failure is null) continue;
            errors.Add(failure);
            if (!connected) unconnected = failure;
        }
        var reopened = reopenedSpid;
        reopenedSpid = null;
        return new(samples, errors, reopened);
    }

    /// <summary>Why an SSISDB source's connection could not open the catalog's database, read in the login's own database on the
    /// same pool's connection (under a live gate and the probe's budget); null when that read fails too, so the open's own
    /// error is reported. A subscription that ends during the read is an OperationCanceledException, however SqlClient words it.</summary>
    private async Task<LiveProbeError?> CatalogFailureAsync(string probe, int budgetMs, CancellationToken token)
    {
        SqlConnection? server = null;
        try
        {
            server = host.PoolConnection(connectionId, null, LiveConnections.SsisSuffix);
            using (var bound = CancellationTokenSource.CreateLinkedTokenSource(token))
            {
                bound.CancelAfter(ConnectBudgetMs);
                await host.OpenAsync(server, bound.Token).ConfigureAwait(false);
            }
            using var lease = await gates.WaitAsync(connectionId, budgetMs, token).ConfigureAwait(false);
            if (lease is null) return null;
            using var budget = CancellationTokenSource.CreateLinkedTokenSource(token);
            budget.CancelAfter(budgetMs);
            await using var command = server.CreateCommand();
            command.CommandTimeout = 0;
            command.CommandText = LiveSql.UncommittedPrologue + LiveSql.CatalogState;
            command.Parameters.Add(new SqlParameter("@catalog", SqlDbType.NVarChar, 128) { Value = host.SsisCatalog });
            await using var reader = await command.ExecuteReaderAsync(CommandBehavior.SingleRow, budget.Token).ConfigureAwait(false);
            return await reader.ReadAsync(budget.Token).ConfigureAwait(false)
                ? LiveErrors.Catalog(probe, Convert.ToInt32(reader.GetValue(0), CultureInfo.InvariantCulture), Convert.ToInt32(reader.GetValue(1), CultureInfo.InvariantCulture))
                : LiveErrors.Catalog(probe, null, null);
        }
        catch (Exception error) when (token.IsCancellationRequested && error is SqlException or InvalidOperationException or OperationCanceledException)
        {
            // As in SampleAsync: the cancel in SqlClient's words ends the subscription cancelled, and a connection cancelled
            // mid-statement goes back to no pool.
            if (server is not null)
            {
                try { SqlConnection.ClearPool(server); }
                catch (InvalidOperationException) { /* Never opened: nothing pooled. */ }
            }
            throw new OperationCanceledException(token);
        }
        catch (Exception error) when (error is SqlException or InvalidOperationException or OperationCanceledException
            || error is RequestException { Code: "AUTH_KERBEROS" or "AUTH_UNSUPPORTED" or "AUTH_ENTRA" })
        {
            return null;
        }
        finally
        {
            if (server is not null) await server.DisposeAsync().ConfigureAwait(false);
        }
    }

    /// <summary>The query's one row as raw values: the clock columns, then each series' value and base by column name; and
    /// its status values, whole numbers by column name (none where the row is missing).</summary>
    private async Task<(LiveRawSample Raw, List<LiveStatus>? Status)> ReadAsync(LiveQuery query, LiveDue item, CancellationToken token)
    {
        await using var command = connection!.CreateCommand();
        command.CommandTimeout = 0;
        // A server DMV source has no admin-only reads; an SSISDB login that is not an admin reads the text without them.
        var text = query.Text(prologue, admin: !ssisdb || admin);
        command.CommandText = testText?.Invoke(item.Probe.Spec.Id, text) ?? text;
        await using var reader = await command.ExecuteReaderAsync(CommandBehavior.SingleRow, token).ConfigureAwait(false);
        // Values are read by their declared position, so a result shaped otherwise is a bug in LiveSql, never a sample.
        if (!query.Returns([.. Enumerable.Range(0, reader.FieldCount).Select(index => (reader.GetName(index), reader.GetFieldType(index)))]))
            throw new RequestException("BACKEND_ERROR", "A live query returned columns other than the ones it declares.");
        // Every live query aggregates to one row; were there none, every series would simply have no value.
        var row = await reader.ReadAsync(token).ConfigureAwait(false);
        double? Value(string? column)
        {
            if (column is null || !row) return null;
            var ordinal = Array.IndexOf(query.Columns, column);
            return ordinal < 0 || reader.IsDBNull(ordinal) ? null : Convert.ToDouble(reader.GetValue(ordinal), CultureInfo.InvariantCulture);
        }
        var series = item.Probe.Spec.Series;
        var values = new double?[series.Count];
        var bases = new double?[series.Count];
        for (var i = 0; i < series.Count; i++)
        {
            var mapping = query.Series.FirstOrDefault(entry => entry.Series == series[i].Id);
            values[i] = Value(mapping?.Column);
            bases[i] = Value(mapping?.Base);
        }
        var msTicks = Value(query.MsTicks);
        var startTicks = Value(query.StartTicks);
        List<LiveStatus>? status = null;
        foreach (var entry in query.Status ?? [])
        {
            var ordinal = Array.IndexOf(query.Columns, entry.Column);
            if (!row || ordinal < 0 || reader.IsDBNull(ordinal)) continue;
            (status ??= []).Add(new LiveStatus(entry.Status, Convert.ToInt64(reader.GetValue(ordinal), CultureInfo.InvariantCulture)));
        }
        return (new(msTicks is { } ms ? (long)ms : null, startTicks is { } start ? (long)start : null, values, bases), status);
    }

    /// <summary>Gives the connection back: to the pool when it is healthy (idle), and never to it when it broke or was cancelled
    /// mid-statement (its pool is cleared, so no other view picks it up).</summary>
    private void Drop(bool baseline = false, bool healthy = false)
    {
        // After a lost connection, which may have reached another server (a failover), rates start again.
        if (baseline) foreach (var probe in deltas.Values) probe.Reset();
        if (connection is not { } held) return;
        connection = null;
        if (!healthy)
        {
            try { SqlConnection.ClearPool(held); }
            catch (InvalidOperationException) { /* Never opened: nothing pooled. */ }
        }
        held.Dispose();
    }

    public void Idle() => Drop(healthy: true);

    public void Apply(object args) { }
    public uint[] Keep() => [];
    public void Release() { }
    public void Dispose() => Drop(healthy: true);
}
