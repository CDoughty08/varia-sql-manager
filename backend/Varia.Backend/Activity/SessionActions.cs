using System.Data;
using System.Data.SqlTypes;
using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Data.SqlClient;
using Varia.Backend.Explorer;
using Varia.Backend.Live;

namespace Varia.Backend.Activity;

/// <summary>What the session actions need from SqlService.</summary>
internal interface IActivityHost
{
    bool IsConnected(string connectionId);
    /// <summary>What was probed at connect, or null when the id is not connected.</summary>
    ServerProfile? Profile(string connectionId);
    /// <summary>An unopened connection from the Activity Monitor's pool (" - Activity Monitor", never silently reconnected).</summary>
    SqlConnection MonitorConnection(string connectionId);
    /// <summary>An unopened connection of the object actions (" - Object Actions"): unpooled, never retried, in master.</summary>
    SqlConnection KillConnection(string connectionId);
    /// <summary>Opens it; a Kerberos or Entra sign-in failure throws AUTH_KERBEROS, AUTH_UNSUPPORTED or AUTH_ENTRA.</summary>
    Task OpenAsync(SqlConnection connection, CancellationToken token);
    /// <summary>The Application Names of every connection of this backend, which their pools' program names start with.
    /// Each connection may set its own, and Kill refuses the pool sessions of all of them.</summary>
    IReadOnlyCollection<string> ApplicationNames();
}

/// <summary>activity.details and activity.kill (D-am §5.5, §8; docs/activity-monitor.md, Session actions). Details reads one
/// session on the monitor's pool under the live gates (it is a unary method on lane live) within its budget; Kill runs
/// ActivitySql's guarded batch per session, in order, on one object-actions connection under its own gates, within its
/// budget. Failures the user can act on are values; only bad requests, an unknown connection, full gates and cancellation
/// are envelope errors. Nothing is logged: no session id, login, host, SQL or message.</summary>
internal sealed partial class SessionActions
{
    private readonly IActivityHost host;
    private readonly LiveService live;
    private readonly ActivityCatalog catalog;
    /// <summary>One Kill at a time per connection, two in the backend: kills are quick, and never wait behind object
    /// actions' DDL (which may wait on a lock as long as it takes, perhaps on the very session the user wants to kill).</summary>
    private readonly LiveGates killGates;

    public SessionActions(IActivityHost host, LiveService live, ActivityCatalog? catalog = null)
    {
        this.host = host;
        this.live = live;
        this.catalog = catalog ?? ActivityCatalog.Current;
        killGates = new(1, 2, host.IsConnected);
        DetailsBudgetMs = (int)this.catalog.Limit("detailsBudgetMs");
        KillBudgetMs = (int)this.catalog.Limit("killBudgetMs");
    }

    /// <summary>The budgets (the catalogue's) and Kill's gate wait; the checks shorten them. Details waits for a live gate
    /// as long as its budget allows (C-critic G12).</summary>
    internal int DetailsBudgetMs { get; set; }
    internal int KillBudgetMs { get; set; }
    internal int GateWaitMs { get; set; } = 5_000;
    /// <summary>The BUSY answers: the live gates are shared with every live view, the kill gates with this window's kills
    /// (one per connection, two in all).</summary>
    internal const string DetailsBusy = "Too many live views are reading this server at once. Retry in a moment.";
    internal const string KillBusy = "Other Kill Process requests are running in this window. Retry when they finish.";

    // --- Validation (src/shared/activity/schema.ts) ---------------------------------------------------------------------

    [GeneratedRegex(@"\A\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?\z")]
    private static partial Regex LoginTimePattern();
    private static readonly string[] LoginTimeFormats = ["yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm:ss.FFFFFFF"];
    /// <summary>datetime's range: a parameter outside it throws (an OverflowException, not a SqlException) before the
    /// command is sent. Past .997 a time rounds up into the year 10000.</summary>
    private static readonly DateTime Earliest = SqlDateTime.MinValue.Value;
    private static readonly DateTime Latest = SqlDateTime.MaxValue.Value;

    private static RequestException Invalid(string detail) => new("INVALID_PARAMS", "Invalid Activity Monitor request: " + detail);

    /// <summary>A login time as the rows carry it (server local time, up to 7 fractional digits, no offset), or null.</summary>
    internal static DateTime? ParseLoginTime(string? value) =>
        value is { Length: <= 40 } && LoginTimePattern().IsMatch(value)
        && DateTime.TryParseExact(value, LoginTimeFormats, CultureInfo.InvariantCulture, DateTimeStyles.None, out var parsed) && parsed >= Earliest && parsed <= Latest ? parsed : null;

    /// <summary>A login time as Details answers it: what sys.dm_exec_sessions holds (datetime, so milliseconds suffice).</summary>
    internal static string FormatLoginTime(DateTime value) => value.ToString("yyyy-MM-dd'T'HH:mm:ss.fff", CultureInfo.InvariantCulture);

    private int SessionLimit => (int)catalog.Limit("sessionId");

    /// <summary>Re-checks activityDetailsRequestSchema: ids, a session id in range, a login time, a known text, and no locks with a text.</summary>
    public DateTime Validate(ActivityDetailsArgs args)
    {
        if (!Guid.TryParse(args.ConnectionId, out _)) throw Invalid("connectionId.");
        if (!Guid.TryParse(args.RequestId, out _)) throw Invalid("requestId.");
        if (args.SessionId < 1 || args.SessionId > SessionLimit) throw Invalid("sessionId.");
        var loginTime = ParseLoginTime(args.LoginTime) ?? throw Invalid("loginTime.");
        if (args.Text is { } text && !catalog.DetailsTexts.Contains(text)) throw Invalid("text.");
        if (args.Text is not null && args.Locks == true) throw Invalid("locks are read only with every section.");
        return loginTime;
    }

    /// <summary>Re-checks activityKillRequestSchema: an id, 1 to 64 distinct sessions in range, each with a login time.</summary>
    public List<(int SessionId, DateTime LoginTime, int? HostProcessId)> Validate(ActivityKillArgs args)
    {
        if (!Guid.TryParse(args.ConnectionId, out _)) throw Invalid("connectionId.");
        if (args.Sessions is not { Count: >= 1 } sessions || sessions.Count > catalog.Limit("killSessions")) throw Invalid("sessions.");
        var checkedSessions = new List<(int, DateTime, int?)>();
        foreach (var session in sessions)
        {
            if (session is null || session.SessionId < 1 || session.SessionId > SessionLimit) throw Invalid("sessionId.");
            checkedSessions.Add((session.SessionId, ParseLoginTime(session.LoginTime) ?? throw Invalid("loginTime."), session.HostProcessId));
        }
        if (checkedSessions.Select(session => session.Item1).Distinct().Count() != checkedSessions.Count) throw Invalid("each session may be named once.");
        return checkedSessions;
    }

    private ActivityRender? RenderOf(string connectionId)
    {
        var profile = host.Profile(connectionId) ?? throw new RequestException("NOT_CONNECTED", "Connect to a SQL Server first.");
        var edition = catalog.EditionOf(profile.EngineEdition);
        var band = ActivitySql.BandOf(profile.Major, profile.EngineEdition, profile.CatalogBand);
        return band is null || edition is null ? null : new ActivityRender(band.Value, edition);
    }

    private static string Permission(string connectionId, IActivityHost host) =>
        host.Profile(connectionId) is { } profile ? LiveConnections.ServerStatePermission(profile) : "VIEW SERVER STATE";

    // --- Details --------------------------------------------------------------------------------------------------------

    public async Task<ActivityDetailsResult> DetailsAsync(ActivityDetailsArgs args, CancellationToken token)
    {
        var loginTime = Validate(args);
        var watch = Stopwatch.StartNew();
        if (RenderOf(args.ConnectionId) is not { } render)
            return new(args.SessionId, "unknown", watch.ElapsedMilliseconds, Error: ActivityErrors.Create("NOT_SUPPORTED", catalog.UnavailableMessage));
        var permission = Permission(args.ConnectionId, host);
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(token);
        budget.CancelAfter(DetailsBudgetMs);
        var gated = false;
        try
        {
            return await live.RunGatedAsync(args.ConnectionId, DetailsBudgetMs, inside =>
            {
                gated = true;
                return ReadDetailsAsync(args, loginTime, render, permission, watch, inside);
            }, budget.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!gated && budget.IsCancellationRequested && !token.IsCancellationRequested)
        {
            // The whole budget went waiting for a live gate (the live views hold them all), as when the wait itself gives up.
            throw new RequestException("BUSY", DetailsBusy);
        }
        catch (Exception error) when (budget.IsCancellationRequested && !token.IsCancellationRequested && error is OperationCanceledException or SqlException or InvalidOperationException)
        {
            return new(args.SessionId, "unknown", watch.ElapsedMilliseconds, Error: ActivityErrors.Create("TIMEOUT", ActivityErrors.DetailsTimeout(DetailsBudgetMs)));
        }
    }

    private async Task<ActivityDetailsResult> ReadDetailsAsync(ActivityDetailsArgs args, DateTime loginTime, ActivityRender render, string permission, Stopwatch watch, CancellationToken token)
    {
        var statements = ActivitySql.Statements("activity.details", render).ToDictionary(statement => statement.Id, StringComparer.Ordinal);
        var connection = host.MonitorConnection(args.ConnectionId);
        // A connection cancelled or broken mid-statement never goes back to the pool for a live view to pick up.
        var healthy = false;
        try
        {
            try { await host.OpenAsync(connection, token).ConfigureAwait(false); }
            catch (RequestException error) when (error.Code is "AUTH_KERBEROS" or "AUTH_UNSUPPORTED" or "AUTH_ENTRA")
            {
                return new(args.SessionId, "unknown", watch.ElapsedMilliseconds, Error: ActivityErrors.SignIn(error));
            }
            catch (SqlException error) when (!token.IsCancellationRequested)
            {
                return new(args.SessionId, "unknown", watch.ElapsedMilliseconds, Error: ActivityErrors.From(error, permission, connecting: true));
            }
            var limit = (int)catalog.Limit("detailsPreviewChars");
            var whole = (int)catalog.Limit("detailsChars");
            // @rowCap is a section's cap plus one, to see truncation.
            Func<ActivityParameter, object?> Values(int rowCap) => parameter => parameter.Name switch
            {
                "@session_id" => args.SessionId,
                "@login_time" => loginTime,
                "@statement_chars" => args.Text is null ? limit : args.Text == "statement" ? whole : 0,
                "@batch_chars" => args.Text is null ? limit : args.Text == "batch" ? whole : 0,
                "@chars" => args.Text is null ? limit : whole,
                "@rowCap" => rowCap + 1,
                _ => throw new InvalidOperationException("No value for " + parameter.Name)
            };
            List<object?[]> rows;
            try
            {
                // SQL Server 2022 checks the joined DMVs' permissions even when this login cannot see the target session.
                // Read sessions alone first so an invisible or reused id has its ended/changed answer without those joins.
                var identity = await ReadAsync(connection, statements["identity"], Values(0), 1, token).ConfigureAwait(false);
                if (identity.Count == 0)
                {
                    healthy = true;
                    return new(args.SessionId, "ended", watch.ElapsedMilliseconds);
                }
                if (!(bool)identity[0][1]!)
                {
                    healthy = true;
                    return new(args.SessionId, "changed", watch.ElapsedMilliseconds);
                }
                // The richer read checks the identity again: a session may end or its id be reused after the preflight.
                rows = await ReadAsync(connection, statements["session"], Values(0), 1, token).ConfigureAwait(false);
            }
            catch (SqlException error) when (!token.IsCancellationRequested)
            {
                var failure = ActivityErrors.From(error, permission);
                healthy = connection.State == ConnectionState.Open && failure.Code != "CONNECTION_LOST";
                return new(args.SessionId, "unknown", watch.ElapsedMilliseconds, Error: failure);
            }
            if (rows.Count == 0)
            {
                healthy = true;
                return new(args.SessionId, "ended", watch.ElapsedMilliseconds);
            }
            var row = rows[0];
            if (!(bool)row[2]!)
            {
                healthy = true;
                return new(args.SessionId, "changed", watch.ElapsedMilliseconds);
            }
            var errors = new List<ActivitySectionError>();
            ActivityText? statement = null, batch = null;
            ActivityInputBufferDto? inputBuffer = null;
            List<ActivitySessionWaitDto>? waits = null;
            List<ActivityTransactionDto>? transactions = null;
            List<ActivityLockDto>? locks = null;
            ActivityTempdbDto? tempdb = null;
            bool? transactionsTruncated = null, locksTruncated = null;
            var broken = false;
            // Each section alone: a permission or a lock that stops one leaves the rest; a broken connection stops them all.
            async Task Section(string id, Action<List<object?[]>> read, int rowCap = 0)
            {
                if (broken) return;
                var spec = statements[id];
                try { read(await ReadAsync(connection, spec, Values(rowCap), rowCap == 0 ? int.MaxValue : rowCap + 1, token).ConfigureAwait(false)); }
                catch (SqlException error) when (!token.IsCancellationRequested)
                {
                    var failure = ActivityErrors.From(error, permission);
                    foreach (var section in spec.Feeds) errors.Add(new(section, failure.Code, failure.Message));
                    broken = failure.Code == "CONNECTION_LOST" || connection.State != ConnectionState.Open;
                }
            }
            if (args.Text is null or "statement" or "batch")
                await Section("texts", texts =>
                {
                    if (texts.FirstOrDefault() is { } found)
                    {
                        if (args.Text is null or "statement") statement = Text(found[1], found[2]);
                        if (args.Text is null or "batch") batch = Text(found[3], found[4]);
                    }
                }).ConfigureAwait(false);
            if (args.Text is null or "inputBuffer")
                await Section("inputBuffer", buffers =>
                {
                    if (buffers.FirstOrDefault() is { } found && Text(found[2], found[3]) is { } text)
                        inputBuffer = new(text, found[0] as string, found[1] is null ? null : Convert.ToInt32(found[1], CultureInfo.InvariantCulture));
                }).ConfigureAwait(false);
            if (args.Text is null)
            {
                await Section("waits", found =>
                {
                    waits = [.. found.Select(item => new ActivitySessionWaitDto((string)item[0]!, Long(item[1]), Long(item[2]), Long(item[3]), Long(item[4])))];
                }).ConfigureAwait(false);
                var transactionCap = (int)catalog.Limit("detailsTransactions");
                await Section("transactions", found =>
                {
                    transactionsTruncated = found.Count > transactionCap;
                    transactions = [.. found.Take(transactionCap).Select(item => new ActivityTransactionDto(Long(item[0]), TransactionType(item[3]), TransactionState(item[4]),
                        item[5] is true, item[1] as string, item[2] is DateTime begin ? FormatLoginTime(begin) : null, item[7] as string ?? (item[6] is null ? null : "database " + Convert.ToInt32(item[6], CultureInfo.InvariantCulture)),
                        item[8] is null ? null : Long(item[8]), item[9] is null ? null : Long(item[9])))];
                }, transactionCap).ConfigureAwait(false);
                await Section("tempdb", found =>
                {
                    if (found.FirstOrDefault() is { } item)
                        tempdb = new(Math.Max(0, Long(item[0]) - Long(item[1]) + Long(item[4]) - Long(item[5])) * 8, Math.Max(0, Long(item[2]) - Long(item[3]) + Long(item[6]) - Long(item[7])) * 8);
                }).ConfigureAwait(false);
                if (args.Locks == true)
                {
                    var lockCap = (int)catalog.Limit("detailsLocks");
                    await Section("locks", found =>
                    {
                        locksTruncated = found.Count > lockCap;
                        locks = [.. found.Take(lockCap).Select(item => new ActivityLockDto((string)item[0]!, (string)item[3]!, (string)item[4]!, Long(item[5]), item[2] as string,
                            item[1] is null ? null : Convert.ToInt32(item[1], CultureInfo.InvariantCulture)))];
                    }, lockCap).ConfigureAwait(false);
                }
            }
            healthy = !broken;
            var serverTime = row[41] is DateTimeOffset at ? at.ToString("yyyy-MM-dd'T'HH:mm:ss.fffzzz", CultureInfo.InvariantCulture) : null;
            return new(args.SessionId, "present", watch.ElapsedMilliseconds, args.Text is null ? Session(row) : null, statement, batch, inputBuffer, waits, transactions, transactionsTruncated,
                tempdb, locks, locksTruncated, errors.Count == 0 ? null : errors, serverTime);
        }
        finally
        {
            if (!healthy)
            {
                try { SqlConnection.ClearPool(connection); }
                catch (InvalidOperationException) { /* Never opened: nothing pooled. */ }
            }
            await connection.DisposeAsync().ConfigureAwait(false);
        }
    }

    /// <summary>Runs a statement with the monitor's prologue and returns at most <paramref name="take"/> rows (DBNull as null).
    /// Its columns are checked against the declaration, so a server that answers otherwise is a bug, never a section.</summary>
    private static async Task<List<object?[]>> ReadAsync(SqlConnection connection, ActivityStatement statement, Func<ActivityParameter, object?> value, int take, CancellationToken token)
    {
        await using var command = connection.CreateCommand();
        command.CommandTimeout = 0;
        command.CommandText = statement.Batch;
        foreach (var parameter in statement.Parameters)
            command.Parameters.Add(new SqlParameter(parameter.Name, parameter.Type) { Value = value(parameter) ?? DBNull.Value, Size = parameter.Size > 0 ? parameter.Size : 0 });
        await using var reader = await command.ExecuteReaderAsync(token).ConfigureAwait(false);
        if (reader.FieldCount != statement.Columns.Count || Enumerable.Range(0, reader.FieldCount).Any(index => !string.Equals(reader.GetName(index), statement.Columns[index], StringComparison.OrdinalIgnoreCase)))
            throw new RequestException("BACKEND_ERROR", "An Activity Monitor statement returned columns other than the ones it declares.");
        var rows = new List<object?[]>();
        while (rows.Count < take && await reader.ReadAsync(token).ConfigureAwait(false))
        {
            var row = new object?[reader.FieldCount];
            reader.GetValues(row!);
            for (var index = 0; index < row.Length; index++) if (row[index] is DBNull) row[index] = null;
            rows.Add(row);
        }
        return rows;
    }

    private static long Long(object? value) => value is null ? 0 : Convert.ToInt64(value, CultureInfo.InvariantCulture);

    private static ActivityText? Text(object? text, object? length) =>
        text is string value ? new(value, Math.Max(value.Length, Long(length)), Long(length) > value.Length) : null;

    private static readonly string[] Isolation = ["Unspecified", "ReadUncommitted", "ReadCommitted", "RepeatableRead", "Serializable", "Snapshot"];
    private static readonly string[] TransactionTypes = ["unknown", "readWrite", "readOnly", "system", "distributed"];
    private static readonly string[] TransactionStates = ["initializing", "initialized", "active", "ended", "commitStarted", "prepared", "committed", "rollingBack", "rolledBack"];
    private static string Name(string[] names, object? value) => value is null ? names[0] : Convert.ToInt32(value, CultureInfo.InvariantCulture) is var index && index >= 0 && index < names.Length ? names[index] : "unknown";
    private static string TransactionType(object? value) => Name(TransactionTypes, value);
    private static string TransactionState(object? value) => value is null ? "unknown" : Name(TransactionStates, value);

    /// <summary>The session statement's row (columns as ActivitySql declares them).</summary>
    private static ActivitySessionDto Session(object?[] row)
    {
        int? Int(int index) => row[index] is null ? null : Convert.ToInt32(row[index], CultureInfo.InvariantCulture);
        long? LongOrNull(int index) => row[index] is null ? null : Long(row[index]);
        string? Str(int index) => row[index] as string;
        string? Time(int index) => row[index] is DateTime value ? FormatLoginTime(value) : null;
        var hasRequest = row[25] is not null;
        var blockedBy = Int(33);
        return new((int)Long(row[0]), FormatLoginTime((DateTime)row[1]!), row[4] is true, Str(5) ?? "", Name(Isolation, row[11]), Str(26) ?? Str(10) ?? "", (int)(LongOrNull(24) ?? 0),
            Long(row[12]) + Long(row[29]), Long(row[15]) + Long(row[30]), Long(row[13]) + Long(row[31]), Long(row[14]) + Long(row[32]), Long(row[16]) * 8, (int)Long(row[17]),
            Str(6), Str(7), Int(3), Str(8), Str(9), Str(20), Str(21), row[22] is string encrypted ? string.Equals(encrypted, "TRUE", StringComparison.OrdinalIgnoreCase) : null, Str(23),
            Str(40), Str(27), hasRequest ? Int(25) : null, Str(34), LongOrNull(35), Str(36), blockedBy is 0 ? null : blockedBy, LongOrNull(28),
            row[37] is null ? null : Convert.ToDouble(row[37], CultureInfo.InvariantCulture), Int(39), row[38] is null ? null : Long(row[38]) * 8, Time(18), Time(19));
    }

    // --- Kill -----------------------------------------------------------------------------------------------------------

    public async Task<ActivityKillResult> KillAsync(ActivityKillArgs args, CancellationToken token)
    {
        var sessions = Validate(args);
        var watch = Stopwatch.StartNew();
        var results = new List<ActivityKillOutcomeDto>();
        if (RenderOf(args.ConnectionId) is not { } render) return new(results, watch.ElapsedMilliseconds, ActivityErrors.Create("NOT_SUPPORTED", catalog.UnavailableMessage));
        var statement = ActivitySql.Statements("activity.kill", render).Single();
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(token);
        budget.CancelAfter(KillBudgetMs);
        var current = 0;
        try
        {
            using var lease = await killGates.WaitAsync(args.ConnectionId, GateWaitMs, budget.Token).ConfigureAwait(false) ?? throw new RequestException("BUSY", KillBusy);
            // Read once the gate is held, so a connection made while this kill waited is in it.
            var pools = PoolList();
            await using var connection = host.KillConnection(args.ConnectionId);
            try { await host.OpenAsync(connection, budget.Token).ConfigureAwait(false); }
            catch (RequestException error) when (error.Code is "AUTH_KERBEROS" or "AUTH_UNSUPPORTED" or "AUTH_ENTRA") { return new(results, watch.ElapsedMilliseconds, ActivityErrors.SignIn(error)); }
            catch (SqlException error) when (!budget.IsCancellationRequested) { return new(results, watch.ElapsedMilliseconds, ActivityErrors.From(error, null, connecting: true)); }
            foreach (var session in sessions)
            {
                current = session.SessionId;
                var outcome = await KillOneAsync(connection, statement, pools, session, budget.Token).ConfigureAwait(false);
                results.Add(outcome);
                if (connection.State != ConnectionState.Open)
                    return new(results, watch.ElapsedMilliseconds, ActivityErrors.Create("CONNECTION_LOST", ActivityErrors.KillLost));
            }
            return new(results, watch.ElapsedMilliseconds);
        }
        catch (Exception error) when (budget.IsCancellationRequested && !token.IsCancellationRequested && error is OperationCanceledException or SqlException or InvalidOperationException)
        {
            // The batch for the session in hand may have reached KILL: its outcome is unknown, and the rest were not tried.
            if (current != 0 && results.All(result => result.SessionId != current)) results.Add(new(current, "failed", ActivityErrors.KillUnknown));
            return new(results, watch.ElapsedMilliseconds, ActivityErrors.Create("TIMEOUT", ActivityErrors.KillTimeout(KillBudgetMs)));
        }
    }

    /// <summary>Kill's @pools: the pool program names of every connection of this backend (each Application Name with each
    /// pool suffix, cut to 128 characters as SqlService names its pools), each between line feeds. A name holding a line feed
    /// of its own still matches itself; it can only add refusals (of a session with this backend's host process id).</summary>
    internal string PoolList()
    {
        var names = host.ApplicationNames().SelectMany(catalog.PoolProgramNames).Distinct(StringComparer.Ordinal);
        return "\n" + string.Join("", names.Select(name => name + "\n"));
    }

    /// <summary>One session's guarded batch. SQL Server's own refusals of KILL (permission, own, not active, not a user
    /// process) map to their outcomes; a connection that breaks during it leaves the outcome unknown, and so does anything
    /// else that goes wrong, so the outcomes already gathered still reach the user.</summary>
    private async Task<ActivityKillOutcomeDto> KillOneAsync(SqlConnection connection, ActivityStatement statement, string pools,
        (int SessionId, DateTime LoginTime, int? HostProcessId) session, CancellationToken token)
    {
        var messages = new StringBuilder();
        void OnInfo(object sender, SqlInfoMessageEventArgs e)
        {
            foreach (SqlError item in e.Errors) if (item.Class <= 10 && messages.Length < 4096) messages.Append(messages.Length > 0 ? " " : "").Append(item.Message);
        }
        connection.InfoMessage += OnInfo;
        try
        {
            await using var command = connection.CreateCommand();
            command.CommandTimeout = 0;
            command.CommandText = ActivitySql.KillPrologue + statement.Text;
            foreach (var parameter in statement.Parameters)
            {
                object? value = parameter.Name switch
                {
                    "@session_id" => session.SessionId,
                    "@login_time" => session.LoginTime,
                    "@host_process_id" => session.HostProcessId,
                    "@backend_pid" => Environment.ProcessId,
                    "@pools" => pools,
                    _ => throw new InvalidOperationException("No value for " + parameter.Name)
                };
                command.Parameters.Add(new SqlParameter(parameter.Name, parameter.Type) { Value = value ?? DBNull.Value, Size = parameter.Size });
            }
            int state;
            try
            {
                await using var reader = await command.ExecuteReaderAsync(token).ConfigureAwait(false);
                state = await reader.ReadAsync(token).ConfigureAwait(false) ? Convert.ToInt32(reader.GetValue(0), CultureInfo.InvariantCulture) : -1;
                // KILL runs after the state: its errors arrive while the reader moves past it.
                while (await reader.NextResultAsync(token).ConfigureAwait(false)) { }
            }
            catch (SqlException error) when (!token.IsCancellationRequested)
            {
                return KillFailure(session.SessionId, error, connection.State == ConnectionState.Open);
            }
            catch (Exception error) when (!token.IsCancellationRequested && error is not OperationCanceledException)
            {
                return new(session.SessionId, "failed", ActivityErrors.KillFailed);
            }
            var outcome = KillOutcome(state);
            var message = outcome == "killed" && messages.Length > 0 ? Clip(messages.ToString()) : outcome == "failed" ? "The kill check returned no state." : null;
            return new(session.SessionId, outcome, message);
        }
        finally { connection.InfoMessage -= OnInfo; }
    }

    /// <summary>The kill batch's state as an outcome (ActivitySql.Kill documents the numbers).</summary>
    internal static string KillOutcome(int state) => state switch
    {
        0 => "killed",
        1 => "ended",
        2 => "own",
        3 => "changed",
        4 => "system",
        5 => "varia",
        _ => "failed"
    };

    /// <summary>KILL refused by SQL Server: 6102 no permission, 6104 its own session, 6106 not an active session (it ended
    /// after the check), 6107 not a user session. Anything else fails with SQL Server's message; when the connection broke,
    /// whether KILL ran is unknown.</summary>
    internal ActivityKillOutcomeDto KillFailure(int sessionId, SqlException error, bool open)
    {
        if (!open) return new(sessionId, "failed", ActivityErrors.KillUnknown);
        var first = error.Errors.Cast<SqlError>().FirstOrDefault(item => item.Class > 10) ?? (error.Errors.Count > 0 ? error.Errors[0] : null);
        return KillFailure(sessionId, first?.Number ?? error.Number, first?.Message ?? error.Message);
    }

    internal ActivityKillOutcomeDto KillFailure(int sessionId, int number, string message) => number switch
    {
        6102 => new(sessionId, "denied"),
        6104 => new(sessionId, "own"),
        6106 => new(sessionId, "ended"),
        6107 => new(sessionId, "system"),
        _ => new(sessionId, "failed", Clip("Msg " + number + ": " + message))
    };

    private string Clip(string text)
    {
        var max = (int)catalog.Limit("killMessageChars");
        return text.Length <= max ? text : text[..(max - 1)] + "…";
    }

    /// <summary>A disconnect: the connection's kill gate goes.</summary>
    public void Forget(string connectionId) => killGates.Forget(connectionId);
}

/// <summary>The session actions' failures as values: live error codes with sentences about Details or Kill. Messages name no
/// session, login or object; SQL Server's own text appears only for an unclassified error (SQL_ERROR).</summary>
internal static class ActivityErrors
{
    public const string KillLost = "The connection was lost while killing sessions; those not listed were not tried.";
    public const string KillUnknown = "The connection broke or time ran out while this session was being killed: whether it ended is unknown. Refresh to see.";
    public const string KillFailed = "Kill Process could not finish for this session: whether it ended is unknown. Refresh to see.";

    public static string DetailsTimeout(int budgetMs) => "Reading the session took longer than " + Seconds(budgetMs) + ". Refresh to try again.";
    public static string KillTimeout(int budgetMs) => "Kill Process took longer than " + Seconds(budgetMs) + "; the sessions not listed were not tried.";
    private static string Seconds(int ms) => (ms + 999) / 1000 is var seconds && seconds == 1 ? "1 second" : seconds + " seconds";

    public static bool Retryable(string code) => !LiveErrors.IsTerminal(code);

    public static ActivityError Create(string code, string message) => new(code, message.Length <= 2000 ? message : message[..1999] + "…", Retryable(code));

    public static ActivityError SignIn(RequestException error) =>
        Create(error.Code == "AUTH_ENTRA" ? "AUTH_ENTRA" : "AUTH_KERBEROS", error.Message.Length > 0 ? error.Message : "Signing in to the server failed.");

    /// <summary>A SQL Server error by LiveErrors' classification. <paramref name="permission"/> names what server state needs
    /// on this server; <paramref name="connecting"/> words a failure to open as such.</summary>
    public static ActivityError From(SqlException error, string? permission, bool connecting = false)
    {
        var first = error.Errors.Cast<SqlError>().FirstOrDefault(item => item.Class > 10) ?? (error.Errors.Count > 0 ? error.Errors[0] : null);
        var number = first?.Number ?? error.Number;
        var code = LiveErrors.Classify(number, first?.Class ?? error.Class);
        return Create(code, code switch
        {
            "BLOCKED" => "Another session held a lock this needed for more than a second. Refresh to try again.",
            "PERMISSION_DENIED" => "This needs the " + (permission ?? "VIEW SERVER STATE") + " permission.",
            "NOT_SUPPORTED" => LiveErrors.UnsupportedMessage,
            "DATABASE_UNAVAILABLE" => "A database this reads is not available. Refresh to try again.",
            "LOGIN_FAILED" => "SQL Server refused the sign-in (the password may have changed, or the login is locked or disabled). Reconnect to sign in again.",
            "CONNECTION_LOST" when connecting => "Could not connect to the server. Check that it is running and reachable, then try again.",
            "CONNECTION_LOST" => "The connection was lost. Refresh to try again.",
            "TIMEOUT" => "The server did not answer in time. Refresh to try again.",
            _ => "Msg " + number + ": " + (first?.Message ?? error.Message)
        });
    }
}
