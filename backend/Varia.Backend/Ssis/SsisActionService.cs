using System.Collections.Concurrent;
using System.Data;
using System.Diagnostics;
using System.Globalization;
using Microsoft.Data.SqlClient;
using Varia.Backend.Common;
using Varia.Backend.Explorer;

namespace Varia.Backend.Ssis;

/// <summary>ssis.execute (D-ssis 4.4), the SSIS Catalog's writes, as ActionService runs object actions: validate, register,
/// refuse what the server cannot do before connecting (no catalog before 2016 or on Linux, SQL Server authentication on a box
/// server for verbs SSISDB refuses it), take the write gates (1 per connection, 2 in all; BUSY after 30 s), open the action's
/// own unpooled connection in the catalog's database, run the verb's preflight there (READ COMMITTED, LOCK_TIMEOUT 10000,
/// within 25 s), then its steps in order, each one constant template that waits for locks as SSMS does. There is no outer
/// transaction: the catalog's procedures manage their own. Failures are values. The reply never waits on blocked I/O: the
/// request awaits the job with its token, and the job alone owns the connection and its gates until it ends. Stop (the
/// request's own token) is the exception, bounded by StopGrace: its reply waits for SQL Server to end the statement, so it
/// says which steps completed. A disconnect answers CANCELLED. Nothing is logged.</summary>
internal sealed class SsisActionService : IDisposable
{
    private readonly ISsisHost host;
    private readonly SsisService reads;
    private readonly SsisCatalog catalog;
    private readonly ExplorerCatalog explorer;
    private readonly RequestRegistry running;
    private readonly ConcurrentDictionary<string, SemaphoreSlim> gates = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, int> sessions = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim total;
    private int activeJobs;

    /// <summary>Shares the read service's options (the catalog's database and the test seams) and its open-failure read.</summary>
    public SsisActionService(ISsisHost host, SsisService reads, ExplorerCatalog? explorer = null)
    {
        this.host = host;
        this.reads = reads;
        catalog = reads.Catalog;
        this.explorer = explorer ?? ExplorerCatalog.Current;
        total = new SemaphoreSlim(Options.WriteTotal);
        running = new RequestRegistry(Options.MaxRegisteredWrites, "Integration Services action");
    }

    public SsisOptions Options => reads.Options;
    /// <summary>Requests registered and not yet answered.</summary>
    public int RunningCount => running.Count;
    /// <summary>Jobs still holding their connection: an answered (stopped) request's job counts until its statement ends.</summary>
    public int ActiveJobs => Volatile.Read(ref activeJobs);
    /// <summary>The server session of a write that is running, once its connection is open: what a "blocked by" read looks up
    /// in sys.dm_exec_requests while it waits (D-ssis 4.4).</summary>
    internal int? SessionOf(string requestId) => sessions.TryGetValue(requestId, out var session) ? session : null;

    private static RequestException Invalid(string detail) => new("INVALID_PARAMS", "Invalid Integration Services action: " + detail);
    private const long MaxSafeInteger = 9_007_199_254_740_991;

    /// <summary>Re-validates ssisExecuteSchema: ids, a verb of the catalogue with exactly its own members, and a revision (64
    /// lowercase hex digits) only for a verb that takes one.</summary>
    public SsisActionSpec Validate(SsisExecuteArgs args)
    {
        if (!Guid.TryParse(args.ConnectionId, out _)) throw Invalid("connectionId.");
        if (!Guid.TryParse(args.RequestId, out _)) throw Invalid("requestId.");
        if (args.Action?.Verb is not { } verb || catalog.Action(verb) is not { } spec) throw Invalid("verb.");
        switch (verb)
        {
            case "stopOperation":
                if (args.Action.OperationId is not (>= 1 and <= MaxSafeInteger)) throw Invalid("operationId.");
                break;
            default:
                throw Invalid("verb.");
        }
        if (args.Revision is { } revision && (!spec.Revision || revision.Length != catalog.Limit("revision") || !revision.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f')))
            throw Invalid(spec.Revision ? "revision." : spec.Title + " takes no revision.");
        return spec;
    }

    public async Task<SsisExecuteResult> ExecuteAsync(SsisExecuteArgs args, CancellationToken token)
    {
        var watch = Stopwatch.StartNew();
        var spec = Validate(args);
        var server = host.Profile(args.ConnectionId);
        var served = server.Explorer(explorer);
        SsisExecuteResult Failed(SsisError error) => new([], watch.ElapsedMilliseconds, error);
        if (served.Band < 13) return Failed(Error("NOT_SUPPORTED", "The SSIS Catalog needs SQL Server 2016 or later."));
        if (served.Linux && !Options.IgnoreLinuxHost) return Failed(Error("NOT_SUPPORTED", "The SSIS Catalog isn't supported on SQL Server on Linux."));
        // A box server's SSISDB refuses a SQL Server login (27123) before it changes anything (S0); Azure SQL Database (5) and
        // Managed Instance (8) host the catalog of an Azure-SSIS integration runtime instead.
        if (spec.WindowsAuthOnBox && server.EngineEdition is not (5 or 8) && host.Authentication(args.ConnectionId) == "sql" && !Options.IgnoreSqlAuthentication)
            return Failed(Error("WINDOWS_AUTH_REQUIRED", SsisErrors.WindowsAuthRequired));
        using var source = CancellationTokenSource.CreateLinkedTokenSource(token);
        var entry = running.Register(args.RequestId, args.ConnectionId, source);
        try
        {
            // A request cancelled before it ran (a CANCEL frame read right after its REQUEST) takes no gate.
            token.ThrowIfCancellationRequested();
            var jobSource = CancellationTokenSource.CreateLinkedTokenSource(source.Token);
            var job = Task.Run(() => JobAsync(args, spec, jobSource), CancellationToken.None);
            _ = job.ContinueWith(done => _ = done.Exception, CancellationToken.None, TaskContinuationOptions.OnlyOnFaulted, TaskScheduler.Default);
            try { return (await job.WaitAsync(source.Token)) with { ElapsedMs = watch.ElapsedMilliseconds }; }
            catch (OperationCanceledException) when (entry.Forgotten && !token.IsCancellationRequested) { throw new RequestException("CANCELLED", "The operation was cancelled."); }
            catch (OperationCanceledException) when (token.IsCancellationRequested && !entry.Forgotten)
            {
                // Stop: SQL Server has the attention already (the job's token); the reply says what completed once it ends.
                try { return (await job.WaitAsync(Options.StopGrace, CancellationToken.None)) with { ElapsedMs = watch.ElapsedMilliseconds }; }
                catch (TimeoutException) { throw new OperationCanceledException(token); }
                // Only the gates, the sign-in or the preflight throw on cancellation: no step had started.
                catch (Exception error) when (error is OperationCanceledException or SqlException) { return Failed(Error("CANCELLED", "The action was stopped before it changed anything.")); }
            }
        }
        finally { running.Unregister(args.RequestId, entry); }
    }

    private async Task<SsisExecuteResult> JobAsync(SsisExecuteArgs args, SsisActionSpec spec, CancellationTokenSource jobSource)
    {
        Interlocked.Increment(ref activeJobs);
        try
        {
            var token = jobSource.Token;
            SsisExecuteResult Failed(SsisError error) => new([], 0, error);
            var gate = gates.GetOrAdd(args.ConnectionId, _ => new SemaphoreSlim(Options.WritePerConnection));
            if (!await gate.WaitAsync(Options.GateWait, token)) throw Busy();
            try
            {
                if (!await total.WaitAsync(Options.GateWait, token)) throw Busy();
                try
                {
                    var name = Options.CatalogDatabase;
                    await using var connection = host.SsisActionConnection(args.ConnectionId, name);
                    try { await host.OpenAsync(connection, token); }
                    catch (RequestException error) when (error.Code is "AUTH_KERBEROS" or "AUTH_UNSUPPORTED" or "AUTH_ENTRA") { return Failed(Error(error.Code, error.Message)); }
                    // Nothing ran yet, so the outcome is known: the action did not start.
                    catch (SqlException error) when (!token.IsCancellationRequested && SsisErrors.CodeOf(error, null) is "NO_DB_ACCESS" or "DATABASE_UNAVAILABLE")
                    {
                        return Failed(await reads.OpenFailureAsync(args.ConnectionId, name, token));
                    }
                    catch (SqlException error) when (!token.IsCancellationRequested) { return Failed(Error("CONNECTION_LOST", "Could not connect to the server: " + error.Message)); }
                    sessions[args.RequestId] = connection.ServerProcessId;
                    try
                    {
                        await RunAsync(connection, SsisSql.ActionPrologue, token);
                        return args.Action.Verb switch
                        {
                            "stopOperation" => await StopOperationAsync(connection, args.Action.OperationId!.Value, spec, token),
                            _ => throw new InvalidOperationException("Unknown SSIS verb.")
                        };
                    }
                    catch (SqlException error) when (!token.IsCancellationRequested)
                    {
                        return Failed(SsisErrors.FromSql(catalog, error, connection, name, "the SSIS Catalog", Doing(args.Action)));
                    }
                    finally { sessions.TryRemove(args.RequestId, out _); }
                }
                finally { total.Release(); }
            }
            finally { gate.Release(); }
        }
        finally
        {
            Interlocked.Decrement(ref activeJobs);
            jobSource.Dispose();
        }
    }

    /// <summary>What a write does, for its error messages ("stop operation 42").</summary>
    private static string Doing(SsisActionDto action) => action.Verb switch
    {
        "stopOperation" => "stop " + Subject(action.OperationId!.Value).ToLowerInvariant(),
        _ => action.Verb
    };

    private static RequestException Busy() => new("BUSY", "Other Integration Services actions are running on this server. Retry after they finish.");
    private SsisError Error(string code, string message) => SsisErrors.Create(catalog, code, message);

    private static async Task RunAsync(SqlConnection connection, string sql, CancellationToken token)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = sql;
        command.CommandTimeout = 0;
        await command.ExecuteNonQueryAsync(token);
    }

    // --- Stop Operation ---------------------------------------------------------------------------------------------------

    private static string Subject(long operationId) => "Operation " + operationId.ToString(CultureInfo.InvariantCulture);

    /// <summary>The operation's type and status in this connection, or null when it does not exist or the login may not read it.</summary>
    private static async Task<(int Type, int Status)?> OperationAsync(SqlConnection connection, long operationId, CancellationToken token)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = SsisSql.OperationPreflight;
        command.CommandTimeout = 0;
        command.Parameters.Add(new SqlParameter("@operation_id", SqlDbType.BigInt) { Value = operationId });
        await using var reader = await command.ExecuteReaderAsync(token);
        if (!await reader.ReadAsync(token)) return null;
        return (Convert.ToInt32(reader.GetValue(0), CultureInfo.InvariantCulture), Convert.ToInt32(reader.GetValue(1), CultureInfo.InvariantCulture));
    }

    /// <summary>Why an operation cannot be stopped as it stands, or null when the catalog should be asked. Created and pending
    /// executions are left to the catalog, which says whether it can stop them (it refuses with 27124 today).</summary>
    internal SsisError? Unstoppable(long operationId, (int Type, int Status)? row)
    {
        var subject = Subject(operationId);
        if (row is not { } found) return Error("NOT_FOUND", subject + " does not exist, or you may not read it (the catalog's retention cleanup may have removed it).");
        if (!catalog.StoppableOperationTypes.Contains(found.Type))
            return Error("NOT_SUPPORTED", subject + " cannot be stopped: its type is " + catalog.OperationTypes.GetValueOrDefault(found.Type, "unknown") + " (" + found.Type + "), and only executions and validations can be stopped.");
        if (catalog.FinalStatuses.Contains(found.Status)) return Error("ALREADY_FINAL", subject + " has already ended (" + Label(found.Status) + ").");
        if (found.Status == 8) return Error("ALREADY_FINAL", subject + " is already stopping.");
        return null;
    }

    private string Label(int status) => catalog.OperationStatuses.GetValueOrDefault(status, "status " + status);

    private async Task<SsisExecuteResult> StopOperationAsync(SqlConnection connection, long operationId, SsisActionSpec spec, CancellationToken token)
    {
        using (var preflight = CancellationTokenSource.CreateLinkedTokenSource(token))
        {
            preflight.CancelAfter(Options.PreflightBudget);
            (int Type, int Status)? row;
            try { row = await OperationAsync(connection, operationId, preflight.Token); }
            catch (Exception error) when (error is OperationCanceledException or SqlException && preflight.IsCancellationRequested && !token.IsCancellationRequested)
            {
                return new([], 0, Error("TIMEOUT", "Checking " + Subject(operationId).ToLowerInvariant() + " took longer than " + (int)Options.PreflightBudget.TotalSeconds + " seconds. Try again."));
            }
            if (Unstoppable(operationId, row) is { } refused) return new([], 0, refused);
        }
        if (Options.BeforeWrite is { } hook) await hook(token);
        var template = SsisSql.WriteTemplates(spec.Verb)[0];
        return await RunStepsAsync(connection, [(spec.Steps[0], async () =>
        {
            await using var command = connection.CreateCommand();
            command.CommandText = template;
            command.CommandTimeout = 0;
            command.Parameters.Add(new SqlParameter("@operation_id", SqlDbType.BigInt) { Value = operationId });
            await command.ExecuteNonQueryAsync(token);
        })], async error =>
        {
            if (!SsisErrors.NotStoppable.Contains(error.Number)) return null;
            // The catalog says the operation is not running, or already stopping: read it again to say which, now.
            var now = await OperationAsync(connection, operationId, token);
            return Unstoppable(operationId, now) ?? (now is { Status: 1 or 5 } waiting
                ? Error("NOT_RUNNING", Subject(operationId) + " has not started running yet (" + Label(waiting.Status) + "); stop it once it runs.")
                : null);
        }, "stop " + Subject(operationId).ToLowerInvariant(), token);
    }

    /// <summary>Runs the steps in order, one statement each: the first failure stops the rest, which are 'skipped'; Stop cancels
    /// the running statement, and earlier steps stay 'done'. <paramref name="explain"/> may turn a catalog error into a clearer
    /// value (null keeps the mapped one).</summary>
    private async Task<SsisExecuteResult> RunStepsAsync(SqlConnection connection, List<(string Title, Func<Task> Run)> plan, Func<SqlException, Task<SsisError?>> explain,
        string doing, CancellationToken token)
    {
        var steps = new List<ActionStepDto>();
        SsisError? failure = null;
        foreach (var (title, run) in plan)
        {
            if (failure is not null) { steps.Add(new("skipped", title)); continue; }
            try
            {
                token.ThrowIfCancellationRequested();
                await run();
                steps.Add(new("done", title));
            }
            catch (Exception exception) when (token.IsCancellationRequested && exception is SqlException or OperationCanceledException)
            {
                steps.Add(new("cancelled", title));
                failure = Error("CANCELLED", "The action was stopped at \"" + title + "\"; SQL Server cancelled that statement." + Completed(steps, "Stop"));
            }
            catch (SqlException sql)
            {
                var value = await explain(sql) ?? SsisErrors.FromSql(catalog, sql, connection, Options.CatalogDatabase, "the SSIS Catalog", doing);
                steps.Add(new("failed", value.Message));
                var done = Completed(steps, "the failure");
                failure = done.Length == 0 ? value : Error(value.Code, value.Message + done);
            }
        }
        return new(steps, 0, failure);
    }

    private static string Completed(List<ActionStepDto> steps, string before)
    {
        var done = steps.Where(step => step.Status == "done").Select(step => step.Message!).ToList();
        return done.Count == 0 ? "" : " Completed before " + before + ": " + string.Join(", ", done) + ".";
    }

    /// <summary>Cancels a disconnected connection's writes and drops its gate.</summary>
    public void Forget(string connectionId)
    {
        running.Forget(connectionId);
        gates.TryRemove(connectionId, out _);
    }

    public void CancelAll() => running.ForgetAll();

    public void Dispose()
    {
        running.ForgetAll();
        gates.Clear();
    }
}
