using System.Data;
using System.Diagnostics;
using System.Globalization;
using System.Text;
using Microsoft.Data.SqlClient;
using Varia.Backend.Explorer;

namespace Varia.Backend.Live;

/// <summary>The pool and the prologue of a live scope (docs/ipc.md, Live subscriptions). Server DMVs read on the
/// connection's " - Activity Monitor" pool in the login's own initial catalog, except Object Explorer's status (below);
/// SSISDB reads (the SSIS sources) use the " - Integration Services" pool with Initial Catalog the catalog's database
/// (SSISDB, or the checks' fake catalog), which the SSIS tree and ssis.describe share with their own prologues. Each scope's
/// pool keeps its SET options away from query tabs, Object Explorer and scripting.</summary>
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

    /// <summary>A source's pool. Object Explorer's status samples by default, for as long as the pane shows, so on a box server
    /// and Managed Instance it opens in master: a session in the login's own database (the Connect dialog's Database, or
    /// the login's default) would keep that database from being restored, set single-user or dropped, and could not connect
    /// while it is offline. Azure SQL Database runs none of its probes and keeps the connection's own catalog, which a contained
    /// user signs in to.</summary>
    public static (string? Database, string Suffix) Pool(string scope, string source, ServerProfile profile, string catalogDatabase) =>
        source == "explorer" && profile.EngineEdition is 1 or 2 or 3 or 4 or 8 ? ("master", Pool(scope, catalogDatabase).Suffix) : Pool(scope, catalogDatabase);

    /// <summary>The live band of a server: its major version (2016 to 2025), or the newest for Managed Instance, which reports
    /// 12 while running the newest engine.</summary>
    public static int Band(ServerProfile profile) => profile.EngineEdition == 8 ? LiveSql.MaxBand : Math.Clamp(profile.Major, LiveSql.MinBand - 1, LiveSql.MaxBand);

    /// <summary>The permission that shows server state: VIEW SERVER PERFORMANCE STATE from SQL Server 2022 (which VIEW SERVER
    /// STATE implies), VIEW SERVER STATE before and on Managed Instance.</summary>
    public static string ServerStatePermission(ServerProfile profile) => profile.EngineEdition != 8 && profile.Major >= 16 ? "VIEW SERVER PERFORMANCE STATE" : "VIEW SERVER STATE";
}

/// <summary>Probes the live checks register through an internal method, never a request field: their queries (by probe id and
/// band), the database their pool opens in, whether they read committed (the READ COMMITTED prologue, as SSISDB with
/// READ_COMMITTED_SNAPSHOT has), and where their append tables start.</summary>
internal sealed record LiveTestSql(Func<string, int, LiveQuery?> Queries, string? Database = null, bool ReadCommitted = false, LiveStart? Start = null);

/// <summary>A SQL source's probes (scope server or ssisdb): one connection from the scope's live pool, held while the subscription samples so its session id
/// is known (the Activity Monitor hides its own session by it) and returned to the pool while nothing is due for a while.
/// Every command runs with the scope's prologue (for SSISDB, READ COMMITTED when the catalog's database has
/// READ_COMMITTED_SNAPSHOT on, as the session probe reads), under a live gate, within the probe's budget (a cancellation token:
/// CommandTimeout is 0). A probe's batch returns its metrics row (columns LiveSql declares, checked on every read; LiveDeltas
/// turns it into rates, and its status columns are sent as they are) and then one result set per table (each checked against the catalogue's column names and types),
/// which the live table writers store (LiveTables.cs): a snapshot table a new revision each sample, an append table the rows
/// above its settled id, read with @after, @top and @before. When one statement of the batch fails after earlier ones
/// returned, the tables already read arrive and the error names the rest. Connecting takes no gate, so a server that stopped
/// answering never holds one that views on other servers need, and has its own bound (15 s), since a profile's Connect
/// Timeout may be 0 (none). Failures are values: a lock wait (BLOCKED), the budget or the connect bound (TIMEOUT), a lost
/// connection (reopened on the next due tick under back-off), a sign-in that fails, a permission error (terminal). The
/// constructor acquires nothing; OpenAsync connects once to read the session id and the permission (unless every probe
/// starts paused: no SQL while paused), and a failure there is reported by the first tick instead. A source with several
/// statements per probe (an ILiveSqlReader, the Activity Monitor's) runs them through the reader on the same connection, under
/// the same gate and budget, and its own session probe replaces LiveSql.Session. An SSISDB source whose connection cannot
/// open the catalog's database reads why on a connection in the login's own database: no catalog (CATALOG_MISSING,
/// terminal), one that is unavailable (retried) or one the login may not open (PERMISSION_DENIED).</summary>
internal sealed class SqlSampler(ILiveHost host, LiveGates gates, string subscriptionId, string connectionId, LiveSourceJson source, LiveLimitsJson limits,
    Func<string, string, string>? testText, LiveTestSql? test = null, ILiveSqlReader? sourceReader = null) : ILiveSampler
{
    /// <summary>The session probe's own budget (D-live: 2 s for the permission probe).</summary>
    private const int SessionBudgetMs = 2000;
    private readonly Dictionary<string, LiveDeltas> deltas = new(StringComparer.Ordinal);
    private readonly Dictionary<string, long> lastAt = new(StringComparer.Ordinal);
    private readonly Dictionary<string, LiveQuery> queries = new(StringComparer.Ordinal);
    /// <summary>The probes a reader runs (a source with several statements per probe).</summary>
    private readonly HashSet<string> readable = new(StringComparer.Ordinal);
    private readonly bool ssisdb = source.Scope == "ssisdb";
    /// <summary>The scope's prologue: an SSISDB source's follows the catalog's READ_COMMITTED_SNAPSHOT, read with the session.</summary>
    private string prologue = test?.ReadCommitted == true ? LiveSql.CommittedPrologue : LiveSql.Prologue(source.Scope, readCommittedSnapshot: false);
    private readonly LiveTableSet tables = new(host.Store, subscriptionId, limits);
    private IReadOnlyList<LiveCursor> resume = [];
    private SqlConnection? connection;
    /// <summary>The session probe ran on the open connection (it waits for a gate, so a connection can open without it).</summary>
    private bool sessionRead;
    /// <summary>What the last session probe found: whether the login reads server state.</summary>
    private bool serverState = true;
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
        this.resume = resume;
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
            (string Reason, string Note)? unavailable = gated ? ("NOT_SUPPORTED", LiveErrors.UnsupportedMessage) : null;
            if (!gated && sourceReader is not null)
            {
                unavailable = sourceReader.Unavailable(spec, profile);
                if (unavailable is null) readable.Add(spec.Id);
            }
            else if (!gated)
            {
                var query = test is not null ? test.Queries(spec.Id, band) : LiveSql.For(spec.Id, band);
                // A query that does not fit its catalogue entry is a bug in LiveSql, never a sample.
                if (query?.Problems(spec) is { Count: > 0 }) throw new RequestException("BACKEND_ERROR", "A live query does not match its catalogue entry.");
                if (query is not null) queries[spec.Id] = query;
                else unavailable = ("NOT_SUPPORTED", LiveErrors.UnsupportedMessage);
            }
            deltas[spec.Id] = new([.. spec.Series.Select(series => series.Counter)]);
            LiveOpenedProbe State(string state, string? reason = null, string? note = null) => new(spec.Id, probe.IntervalMs, spec.IntervalMs.Min, spec.IntervalMs.Max, state, reason, note);
            states.Add(unavailable is { } why ? State("unavailable", why.Reason, why.Note)
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
        var (database, suffix) = host.Profile(connectionId) is { } profile ? LiveConnections.Pool(source.Scope, source.Id, profile, host.SsisCatalog) : LiveConnections.Pool(source.Scope, host.SsisCatalog);
        var opening = host.PoolConnection(connectionId, test?.Database ?? database, suffix);
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
            if (sourceReader is not null) (session, allowed) = await sourceReader.SessionAsync(connection!, prologue, permission, budget.Token).ConfigureAwait(false);
            else
            {
                await using var command = connection!.CreateCommand();
                command.CommandTimeout = 0;
                command.CommandText = prologue + LiveSql.Session;
                command.Parameters.Add(new SqlParameter("@permission", SqlDbType.NVarChar, 128) { Value = permission });
                command.Parameters.Add(new SqlParameter("@catalog", SqlDbType.NVarChar, 128) { Value = ssisdb ? host.SsisCatalog : DBNull.Value });
                await using var row = await command.ExecuteReaderAsync(budget.Token).ConfigureAwait(false);
                if (!await row.ReadAsync(budget.Token).ConfigureAwait(false)) throw new InvalidOperationException("The session probe returned no row.");
                session = Convert.ToInt32(row.GetValue(0), CultureInfo.InvariantCulture);
                allowed = Convert.ToInt32(row.GetValue(1), CultureInfo.InvariantCulture) == 1;
                if (ssisdb && test?.ReadCommitted != true) prologue = LiveSql.Prologue(source.Scope, !row.IsDBNull(2) && Convert.ToInt32(row.GetValue(2), CultureInfo.InvariantCulture) == 1);
                admin = ssisdb && Convert.ToInt32(row.GetValue(3), CultureInfo.InvariantCulture) == 1;
            }
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
        serverState = allowed;
        return allowed;
    }

    public async Task<LiveSampleBatch> SampleAsync(IReadOnlyList<LiveDue> due, CancellationToken token)
    {
        var samples = new List<LiveSample>();
        var errors = new List<LiveProbeError>();
        tables.BeginTick();
        // A connect that failed this tick: the other due probes report it rather than try again at once.
        LiveProbeError? unconnected = null;
        foreach (var item in due)
        {
            var id = item.Probe.Spec.Id;
            var byReader = readable.Contains(id);
            if (!queries.TryGetValue(id, out var query) && !byReader)
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
                // A probe that needs server state the login lacks runs nothing, as it would have opened unavailable had the
                // session probe run then (the source opened paused, the gates were full, the connect failed), or as a new
                // connection finds it. Terminal: the probe stops.
                if (item.Probe.Spec.Permission == "serverState" && !serverState)
                {
                    errors.Add(LiveErrors.Create(id, "PERMISSION_DENIED", LiveErrors.PermissionMessage));
                    continue;
                }
                budget.CancelAfter(item.BudgetMs);
                var started = Stopwatch.GetTimestamp();
                var read = byReader ? await sourceReader!.ReadAsync(connection!, prologue, item, testText, budget.Token).ConfigureAwait(false) : await ReadAsync(query!, item, budget.Token).ConfigureAwait(false);
                var cost = (int)Math.Min(int.MaxValue, Stopwatch.GetElapsedTime(started).TotalMilliseconds);
                if (!read.Sampled)
                {
                    // Nothing was read: the probe failed (it backs off), and its first error says why.
                    errors.Add(read.Errors[0]);
                    if (connection is not { State: ConnectionState.Open }) Drop(baseline: true);
                    continue;
                }
                var now = Stopwatch.GetTimestamp();
                long? clientElapsed = lastAt.TryGetValue(id, out var before) ? (long)Stopwatch.GetElapsedTime(before, now).TotalMilliseconds : null;
                lastAt[id] = now;
                double?[]? metrics = null;
                long? elapsed = item.Gap is "baseline" or "resumed" ? null : clientElapsed;
                var gap = item.Gap;
                if (read.Raw is { } raw)
                {
                    var result = deltas[id].Apply(raw, clientElapsed, item.EffectiveIntervalMs, item.Gap);
                    (metrics, elapsed, gap) = (result.Values, result.ElapsedMs, SeriesGap(result.Gap, read.SeriesReset));
                }
                // A probe of status values alone has no rates to start again (so no quick second sample after a baseline) and
                // sends no metrics.
                if (item.Probe.Spec.Series.Count == 0 && item.Probe.Spec.Tables.Count == 0) (metrics, gap) = (null, item.Gap == "late" ? "late" : null);
                var (snapshots, appends, full) = Store(item, read.Tables);
                samples.Add(new LiveSample(id, cost, item.EffectiveIntervalMs, elapsed, gap, item.Skipped, metrics, snapshots.Count > 0 ? snapshots : null, appends.Count > 0 ? appends : null,
                    read.Status is { Count: > 0 } status ? status : null));
                if (full.Count > 0) errors.Add(LiveErrors.Create(id, "BUDGET", LiveErrors.BudgetMessage) with { Tables = [.. full] });
                foreach (var partial in read.Errors)
                {
                    errors.Add(partial);
                    if (LiveErrors.Breaks(partial.Code) || connection is not { State: ConnectionState.Open }) Drop(baseline: partial.Code == "CONNECTION_LOST");
                }
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
        var cursors = tables.Cursors();
        return new(samples, errors, reopened, cursors.Count > 0 ? cursors : null);
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

    /// <summary>A sample whose series follow something else from now on (SeriesReset) is marked reset, unless it already starts
    /// them again (baseline, resumed, reset); reset outranks late.</summary>
    internal static string? SeriesGap(string? gap, bool seriesReset) => seriesReset && gap is null or "late" ? "reset" : gap;

    /// <summary>Starts each append table that has not started, or whose predicate (a restart filter) changed, then runs the
    /// probe's batch: the metrics row, then each table's result set. A statement that failed after earlier ones returned is
    /// an error naming the tables it left unread.</summary>
    private async Task<LiveReaderSample> ReadAsync(LiveQuery query, LiveDue item, CancellationToken token)
    {
        var spec = item.Probe.Spec;
        var pattern = query.Filtered && item.Filter?.Text is { Length: > 0 } text ? Pattern(text) : null;
        foreach (var read in query.Tables.Where(read => spec.Tables[read.Table].Mode == "append"))
        {
            var table = tables.Append(spec, read.Table);
            var predicate = pattern ?? "";
            if (table.Started && table.Predicate == predicate) continue;
            var cursor = table.Started ? null : resume.FirstOrDefault(entry => entry.Probe == spec.Id && entry.Table == read.Table);
            if (cursor is not null) table.Start(cursor.SettledId, null, null, predicate);
            else await StartAsync(table, read, spec.Tables[read.Table], pattern, predicate, token).ConfigureAwait(false);
        }

        await using var command = connection!.CreateCommand();
        command.CommandTimeout = 0;
        // A server DMV source has no admin-only reads; an SSISDB login that is not an admin reads the text without them.
        var commandText = query.Text(prologue, admin: !ssisdb || admin);
        command.CommandText = testText?.Invoke(spec.Id, commandText) ?? commandText;
        foreach (var read in query.Tables.Where(read => spec.Tables[read.Table].Mode == "append"))
        {
            var table = tables.Append(spec, read.Table);
            var suffix = read.Table.ToString(CultureInfo.InvariantCulture);
            command.Parameters.Add(new SqlParameter("@after" + suffix, SqlDbType.BigInt) { Value = table.SettledId });
            command.Parameters.Add(new SqlParameter("@top" + suffix, SqlDbType.Int) { Value = table.ReadRows });
            command.Parameters.Add(new SqlParameter("@before" + suffix, SqlDbType.BigInt) { Value = table.Before is { } end ? end : DBNull.Value });
        }
        if (query.Filtered) command.Parameters.Add(new SqlParameter("@filter", SqlDbType.NVarChar, 2 * limits.FilterCharacters + 2) { Value = (object?)pattern ?? DBNull.Value });
        var reader = await command.ExecuteReaderAsync(query.Tables.Length == 0 ? CommandBehavior.SingleRow : CommandBehavior.Default, token).ConfigureAwait(false);
        LiveProbeError? partial = null;
        try
        {
            LiveRawSample? raw = null;
            IReadOnlyList<LiveStatus>? status = null;
            if (query.Columns.Length > 0)
            {
                (raw, status) = await MetricsAsync(query, item, reader, token).ConfigureAwait(false);
                if (query.Tables.Length > 0 && !await reader.NextResultAsync(token).ConfigureAwait(false)) throw new RequestException("BACKEND_ERROR", "A live query returned fewer result sets than it declares.");
            }
            var results = new List<LiveReaderTable>();
            for (var at = 0; at < query.Tables.Length; at++)
            {
                try
                {
                    if (at > 0 && !await reader.NextResultAsync(token).ConfigureAwait(false)) throw new RequestException("BACKEND_ERROR", "A live query returned fewer result sets than it declares.");
                    var table = query.Tables[at];
                    var catalogTable = spec.Tables[table.Table];
                    var cap = catalogTable.Mode == "append" ? tables.Append(spec, table.Table).ReadRows : limits.SnapshotRows;
                    var (rows, more) = await RowsAsync(reader, catalogTable, cap, token).ConfigureAwait(false);
                    var view = item.View is { } chosen && table.View is { } predicate ? row => predicate(chosen, row) : (Func<LiveRow, bool>?)null;
                    results.Add(new(table.Table, rows, more, view));
                }
                catch (SqlException error) when (!token.IsCancellationRequested && (raw is not null || results.Count > 0))
                {
                    // One statement failed after earlier ones returned: those tables arrive, and the error names the rest.
                    partial = LiveErrors.From(spec.Id, error) with { Tables = [.. query.Tables.Skip(at).Select(table => table.Table)] };
                    return new(raw, results, [partial], Status: status);
                }
            }
            return new(raw, results, [], Status: status);
        }
        finally
        {
            // Closing a reader whose batch already failed can raise that failure again; it is reported once, as the value above.
            try { await reader.DisposeAsync().ConfigureAwait(false); }
            catch (SqlException) when (partial is not null) { }
        }
    }

    /// <summary>Where an append table starts: at its first row, or, for a source that asks for its last rows or the rows before
    /// an id, where the table's tail statement says (with a note row naming the rows it leaves out).</summary>
    private async Task StartAsync(LiveAppendTable table, LiveTableRead read, LiveTableJson spec, string? pattern, string predicate, CancellationToken token)
    {
        var start = test?.Start ?? LiveStart.Beginning;
        long? before = start.Kind == "before" ? start.Value : null;
        if (start.Kind == "beginning" || read.Tail is null)
        {
            table.Start(0, before, null, predicate);
            return;
        }
        var suffix = read.Table.ToString(CultureInfo.InvariantCulture);
        await using var command = connection!.CreateCommand();
        command.CommandTimeout = 0;
        command.CommandText = prologue + read.Tail;
        command.Parameters.Add(new SqlParameter("@tail" + suffix, SqlDbType.Int) { Value = (int)Math.Min(start.Kind == "tail" ? start.Value : limits.SegmentRows, limits.SegmentRows) });
        command.Parameters.Add(new SqlParameter("@before" + suffix, SqlDbType.BigInt) { Value = before is { } end ? end : DBNull.Value });
        command.Parameters.Add(new SqlParameter("@filter", SqlDbType.NVarChar, 2 * limits.FilterCharacters + 2) { Value = (object?)pattern ?? DBNull.Value });
        await using var reader = await command.ExecuteReaderAsync(CommandBehavior.SingleRow, token).ConfigureAwait(false);
        if (reader.FieldCount != 2 || reader.GetName(0) != "after_id" || reader.GetName(1) != "earlier") throw new RequestException("BACKEND_ERROR", "A live tail statement returned other columns than it declares.");
        long after = 0, earlier = 0;
        if (await reader.ReadAsync(token).ConfigureAwait(false))
        {
            after = reader.IsDBNull(0) ? 0 : Convert.ToInt64(reader.GetValue(0), CultureInfo.InvariantCulture);
            earlier = reader.IsDBNull(1) ? 0 : Convert.ToInt64(reader.GetValue(1), CultureInfo.InvariantCulture);
        }
        table.Start(after, before, earlier > 0 ? Note(spec, earlier) : null, predicate);
    }

    /// <summary>The note row: the start's text in the table's first text column, every other cell NULL.</summary>
    private static LiveRow? Note(LiveTableJson spec, long earlier)
    {
        var column = spec.Columns.FindIndex(item => item.DataType is "nvarchar" or "varchar" or "nchar" or "char" or "sysname");
        if (column < 0) return null;
        var cells = Enumerable.Repeat(LiveCell.Null, spec.Columns.Count).ToArray();
        cells[column] = LiveCell.Of(LiveStart.Note(earlier));
        return new LiveRow(cells);
    }

    /// <summary>A LIKE pattern that finds the text anywhere, its wildcards escaped (ESCAPE N'\').</summary>
    internal static string Pattern(string text)
    {
        var escaped = new StringBuilder(text.Length + 2).Append('%');
        foreach (var character in text)
        {
            if (character is '%' or '_' or '[' or '\\') escaped.Append('\\');
            escaped.Append(character);
        }
        return escaped.Append('%').ToString();
    }

    /// <summary>A table's rows, checked against the catalogue's columns (names, order, types), at most <paramref name="cap"/>;
    /// More counts the rows past it, which the writer reports as cut.</summary>
    private static async Task<(List<LiveRow> Rows, long More)> RowsAsync(SqlDataReader reader, LiveTableJson spec, int cap, CancellationToken token)
    {
        if (reader.FieldCount != spec.Columns.Count || spec.Columns.Where((column, at) => reader.GetName(at) != column.Name || !LiveCells.Matches(column.DataType, reader.GetDataTypeName(at))).Any())
            throw new RequestException("BACKEND_ERROR", "A live query returned columns other than the ones its table declares.");
        var schema = reader.GetColumnSchema();
        var scales = schema.Select(column => column.NumericScale is >= 0 and <= 7 ? column.NumericScale.Value : 7).ToArray();
        var rows = new List<LiveRow>();
        long more = 0;
        while (await reader.ReadAsync(token).ConfigureAwait(false))
        {
            if (rows.Count >= cap) { more++; continue; }
            var cells = new LiveCell[spec.Columns.Count];
            for (var at = 0; at < cells.Length; at++) cells[at] = LiveCells.Read(reader, at, spec.Columns[at].DataType, scales[at]);
            rows.Add(new LiveRow(cells));
        }
        return (rows, more);
    }

    /// <summary>The metrics row as raw values: the clock columns, then each series' value and base by column name; and its
    /// status values, whole numbers by column name (none where the row is missing).</summary>
    private static async Task<(LiveRawSample Raw, List<LiveStatus>? Status)> MetricsAsync(LiveQuery query, LiveDue item, SqlDataReader reader, CancellationToken token)
    {
        // Values are read by their declared position, so a result shaped otherwise is a bug in LiveSql, never a sample.
        if (!query.Returns([.. Enumerable.Range(0, reader.FieldCount).Select(index => (reader.GetName(index), reader.GetFieldType(index)))]))
            throw new RequestException("BACKEND_ERROR", "A live query returned columns other than the ones it declares.");
        // Every metrics query aggregates to one row; were there none, every series would simply have no value.
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
        var raw = new LiveRawSample(msTicks is { } ms ? (long)ms : null, startTicks is { } start ? (long)start : null, values, bases);
        // A batch with tables goes on to their result sets; the row's own result set must hold no more rows.
        while (row && await reader.ReadAsync(token).ConfigureAwait(false)) { }
        return (raw, status);
    }

    /// <summary>Writes each table read: a snapshot as its next revision (sorted, filtered and viewed as the probe asks), an
    /// append table by its new rows. Returns the samples and the tables the budget cut.</summary>
    private (List<LiveSnapshotSample> Snapshots, List<LiveAppendSample> Appends, List<int> Full) Store(LiveDue item, List<LiveReaderTable> read)
    {
        var spec = item.Probe.Spec;
        var snapshots = new List<LiveSnapshotSample>();
        var appends = new List<LiveAppendSample>();
        var full = new List<int>();
        foreach (var (index, rows, more, view, scope) in read)
        {
            if (spec.Tables[index].Mode == "snapshot")
            {
                var write = tables.Snapshot(spec, index).Write(rows, new(item.Sort, spec.FilterMode == "memory" ? item.Filter : null, view, item.Tracks.GetValueOrDefault(index), scope), more);
                if (write.Sample is { } sample) snapshots.Add(sample);
                if (write.Budget) full.Add(index);
            }
            else
            {
                var write = tables.Append(spec, index).Append(rows, Environment.TickCount64);
                if (write.Sample is { } sample) appends.Add(sample);
                if (write.Budget) full.Add(index);
            }
        }
        return (snapshots, appends, full);
    }

    /// <summary>Gives the connection back: to the pool when it is healthy (idle), and never to it when it broke or was cancelled
    /// mid-statement (its pool is cleared, so no other view picks it up).</summary>
    private void Drop(bool baseline = false, bool healthy = false)
    {
        // After a lost connection, which may have reached another server (a failover), rates start again.
        if (baseline)
        {
            foreach (var probe in deltas.Values) probe.Reset();
            sourceReader?.Reset();
        }
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

    public void Apply(object args) => sourceReader?.Apply(args);
    public uint[] Keep() => tables.Keep(limits.Kept);
    public void Release() => tables.Release();
    public void Dispose() => Drop(healthy: true);
}
