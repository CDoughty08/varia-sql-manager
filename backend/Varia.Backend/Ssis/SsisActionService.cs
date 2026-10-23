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
/// says which steps completed (Create Catalog's past the grace too: it lets its restore end, then removes what it made). A
/// disconnect answers CANCELLED. Nothing is logged.</summary>
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
        var action = args.Action;
        switch (verb)
        {
            case "stopOperation":
                if (action.OperationId is not (>= 1 and <= MaxSafeInteger)) throw Invalid("operationId.");
                if (action.Password is not null || action.EnableClr is not null || action.StartupProcedure is not null) throw Invalid("Stop Operation takes only an operationId.");
                break;
            case "createCatalog":
                // The password's length and characters only: SQL Server's own policy decides the rest, and nothing echoes it.
                if (action.Password is not { Length: > 0 } password || password.Length > catalog.Limit("catalogPassword") || password.Contains('\0')) throw Invalid("password.");
                if (action.EnableClr is null || action.StartupProcedure is null) throw Invalid("Create Catalog needs enableClr and startupProcedure.");
                if (action.OperationId is not null) throw Invalid("Create Catalog takes no operationId.");
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
        if (spec.Server)
        {
            if (SsisCreate.Unsupported(catalog, served, server.EngineEdition, Options.IgnoreLinuxHost) is { } unsupported) return Failed(unsupported);
        }
        else
        {
            if (served.Band < 13) return Failed(Error("NOT_SUPPORTED", "The SSIS Catalog needs SQL Server 2016 or later."));
            if (served.Linux && !Options.IgnoreLinuxHost) return Failed(Error("NOT_SUPPORTED", "The SSIS Catalog isn't supported on SQL Server on Linux."));
        }
        // A box server's SSISDB refuses a SQL Server login (27123) before it changes anything (S0); Azure SQL Database (5) and
        // Managed Instance (8) host the catalog of an Azure-SSIS integration runtime instead.
        if (spec.WindowsAuthOnBox && server.EngineEdition is not (5 or 8) && host.Authentication(args.ConnectionId) == "sql" && !Options.IgnoreSqlAuthentication)
            return Failed(Error("WINDOWS_AUTH_REQUIRED", SsisErrors.WindowsAuthRequired));
        using var source = CancellationTokenSource.CreateLinkedTokenSource(token);
        var entry = running.Register(args.RequestId, args.ConnectionId, source);
        var progress = new JobProgress();
        try
        {
            // A request cancelled before it ran (a CANCEL frame read right after its REQUEST) takes no gate.
            token.ThrowIfCancellationRequested();
            var jobSource = CancellationTokenSource.CreateLinkedTokenSource(source.Token);
            var job = Task.Run(() => JobAsync(args, spec, jobSource, progress), CancellationToken.None);            _ = job.ContinueWith(done => _ = done.Exception, CancellationToken.None, TaskContinuationOptions.OnlyOnFaulted, TaskScheduler.Default);
            try { return (await job.WaitAsync(source.Token)) with { ElapsedMs = watch.ElapsedMilliseconds }; }
            catch (OperationCanceledException) when (entry.Forgotten && !token.IsCancellationRequested) { throw new RequestException("CANCELLED", "The operation was cancelled."); }
            catch (OperationCanceledException) when (token.IsCancellationRequested && !entry.Forgotten)
            {
                return (await AfterStopAsync(job, progress, entry.ForgottenToken, token)) with { ElapsedMs = watch.ElapsedMilliseconds };
            }
        }
        finally { running.Unregister(args.RequestId, entry); }
    }

    /// <summary>Stop's reply. SQL Server has the attention already (the job's token), and the reply says what completed once the job
    /// ends, within StopGrace. A job that answers Stop itself (<see cref="JobProgress.Committed"/>: Create Catalog from its restore on,
    /// which lets the restore end and then removes what it created) is waited for past the grace, so the reply says which; a
    /// disconnect (<paramref name="forgotten"/>) still answers at once. Otherwise past the grace the request answers CANCELLED.</summary>
    internal async Task<SsisExecuteResult> AfterStopAsync(Task<SsisExecuteResult> job, JobProgress progress, CancellationToken forgotten, CancellationToken stop)
    {
        try { return await job.WaitAsync(Options.StopGrace, CancellationToken.None); }
        catch (TimeoutException) when (progress.Committed)
        {
            try { return await job.WaitAsync(forgotten); }
            catch (OperationCanceledException) { throw new RequestException("CANCELLED", "The operation was cancelled."); }
        }
        catch (TimeoutException) { throw new OperationCanceledException(stop); }
        // Only the gates, the sign-in or the preflight throw on cancellation: no step had started.
        catch (Exception error) when (error is OperationCanceledException or SqlException) { return new([], 0, Error("CANCELLED", "The action was stopped before it changed anything.")); }
    }

    /// <summary>Whether a job answers Stop itself once SQL Server lets it (Create Catalog from the start of its restore, which Stop
    /// cannot end, through the removal of what it created): its Stop reply then waits for it.</summary>
    internal sealed class JobProgress
    {
        private int committed;
        public bool Committed => Volatile.Read(ref committed) == 1;
        public void Commit() => Volatile.Write(ref committed, 1);
    }

    private async Task<SsisExecuteResult> JobAsync(SsisExecuteArgs args, SsisActionSpec spec, CancellationTokenSource jobSource, JobProgress progress)
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
                    // Create Catalog runs in master, where SSMS runs it: its catalog does not exist yet.
                    await using var connection = host.SsisActionConnection(args.ConnectionId, spec.Server ? "master" : name);
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
                            "createCatalog" => await CreateCatalogAsync(connection, args.ConnectionId, args.Action, spec, progress, token),
                            _ => throw new InvalidOperationException("Unknown SSIS verb.")
                        };
                    }
                    // RunStepsAsync answers for its steps, so what reaches here ran before the first one: nothing was sent.
                    catch (SqlException error) when (!token.IsCancellationRequested)
                    {
                        return Failed(SsisErrors.FromSql(catalog, error, connection, name, "the SSIS Catalog", Doing(args.Action), sent: false));
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
        "createCatalog" => "create the SSIS Catalog",
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

    /// <summary>Why an operation cannot be stopped as it stands, or null when the catalog should be asked. A created execution
    /// that nobody started (a failed start, a script, another tool) never runs, so there is nothing to stop and no retry helps;
    /// pending ones are left to the catalog, which says whether it can stop them (it refuses with 27124 today).</summary>
    internal SsisError? Unstoppable(long operationId, (int Type, int Status)? row)
    {
        var subject = Subject(operationId);
        if (row is not { } found) return Error("NOT_FOUND", subject + " does not exist, or you may not read it (the catalog's retention cleanup may have removed it).");
        if (!catalog.StoppableOperationTypes.Contains(found.Type))
            return Error("NOT_SUPPORTED", subject + " cannot be stopped: its type is " + catalog.OperationTypes.GetValueOrDefault(found.Type, "unknown") + " (" + found.Type + "), and only executions and validations can be stopped.");
        if (catalog.FinalStatuses.Contains(found.Status)) return Error("ALREADY_FINAL", subject + " has already ended (" + Label(found.Status) + ").");
        if (found.Status == 8) return Error("ALREADY_FINAL", subject + " is already stopping.");
        if (found.Status == 1) return Error("NOT_STARTED", subject + " was created but has not been started, so there is nothing to stop.");
        return null;
    }

    /// <summary>What Stop leaves behind at Stop Operation's step: catalog.stop_operation records its own Stop operation (202,
    /// Running) before its transaction, and a cancelled statement never reaches the procedure's error path, so SQL Server rolls
    /// back the stop but that row stays Running until the catalog's startup procedure ends it (SSMS never cancels it).</summary>
    internal const string StoppedStopNote = " SQL Server rolled back the stop, but the SSIS Catalog may list the Stop operation it had recorded as Running until SQL Server restarts.";

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
            (int Type, int Status)? now;
            try
            {
                if (Options.BeforeReread is { } hook) await hook(token);
                now = await OperationAsync(connection, operationId, token);
            }
            // The catalog's refusal stands when the second look fails (a lock, a lost connection, Stop): the step still failed.
            catch (Exception failure) when (failure is SqlException or OperationCanceledException) { return null; }
            return Unstoppable(operationId, now) ?? (now is { Status: 5 }
                ? Error("NOT_RUNNING", Subject(operationId) + " has not started running yet (" + Label(5) + "); stop it once it runs.")
                : null);
        }, "stop " + Subject(operationId).ToLowerInvariant(), StoppedStopNote, token);
    }

    /// <summary>Runs the steps in order, one statement each: the first failure stops the rest, which are 'skipped'; Stop cancels
    /// the running statement, and earlier steps stay 'done'. <paramref name="explain"/> may turn a catalog error into a clearer
    /// value (null keeps the one mapped when the step failed). <paramref name="stopped"/> says what a cancelled step may leave.</summary>
    private async Task<SsisExecuteResult> RunStepsAsync(SqlConnection connection, List<(string Title, Func<Task> Run)> plan, Func<SqlException, Task<SsisError?>> explain,
        string doing, string stopped, CancellationToken token)
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
                failure = Error("CANCELLED", "The action was stopped at \"" + title + "\"; SQL Server cancelled that statement." + stopped + Completed(steps, "Stop"));
            }
            catch (SqlException sql)
            {
                // Mapped before explain reads again, while the connection's state is still the step's own.
                var mapped = SsisErrors.FromSql(catalog, sql, connection, Options.CatalogDatabase, "the SSIS Catalog", doing);
                var value = await explain(sql) ?? mapped;
                steps.Add(new("failed", value.Message));
                var done = Completed(steps, "the failure");
                failure = done.Length == 0 ? value : Error(value.Code, value.Message + done);
            }
        }
        return new(steps, 0, failure);
    }

    // --- Create Catalog -----------------------------------------------------------------------------------------------------

    /// <summary>The catalog's database Create Catalog makes: SSISDB, or the live checks' scratch database in a dry run.</summary>
    private string CreateName => Options.CreateScratch ?? catalog.CatalogDatabase;

    private async Task<SsisExecuteResult> CreateCatalogAsync(SqlConnection connection, string connectionId, SsisActionDto action, SsisActionSpec spec, JobProgress progress, CancellationToken token)
    {
        var name = CreateName;
        var dryRun = Options.CreateScratch is not null;
        var band = host.Profile(connectionId).Explorer(explorer).Band;
        CatalogFacts facts;
        CatalogBackupLayout layout;
        using (var preflight = CancellationTokenSource.CreateLinkedTokenSource(token))
        {
            preflight.CancelAfter(Options.PreflightBudget);
            try
            {
                facts = await SsisCreate.ReadAsync(connection, catalog, name, band, preflight.Token);
                if (SsisCreate.Refusal(catalog, facts, name) is { } refused) return new([], 0, refused);
                var (found, unusable) = await SsisCreate.LayoutAsync(connection, catalog, facts.BackupFile!, preflight.Token);
                if (unusable is not null) return new([], 0, unusable);
                layout = found!;
            }
            catch (Exception error) when (error is OperationCanceledException or SqlException && preflight.IsCancellationRequested && !token.IsCancellationRequested)
            {
                return new([], 0, Error("TIMEOUT", "Checking the server took longer than " + (int)Options.PreflightBudget.TotalSeconds + " seconds. Try again."));
            }
            catch (SqlException error) when (!token.IsCancellationRequested)
            {
                return new([], 0, SsisErrors.FromSql(catalog, error, connection, "master", "the server", "create the SSIS Catalog", sent: false));
            }
        }
        var enableClr = !facts.ClrEnabled && !dryRun;
        if (enableClr && action.EnableClr != true)
            return new([], 0, Error("CLR_REQUIRED", "Integration Services uses CLR stored procedures. Enable CLR integration to create the catalog."));
        if (Options.BeforeWrite is { } hook) await hook(token);

        var steps = new List<ActionStepDto>();
        var titles = spec.Steps;
        if (enableClr)
        {
            try
            {
                token.ThrowIfCancellationRequested();
                await RunAsync(connection, SsisCreateSql.EnableClr, [], token);
                steps.Add(new("done", titles[0]));
            }
            catch (Exception exception) when (token.IsCancellationRequested && exception is SqlException or OperationCanceledException)
            {
                steps.Add(new("cancelled", titles[0]));
                return new(steps, 0, Error("CANCELLED", "Create Catalog was stopped at \"" + titles[0] + "\"; SQL Server cancelled that statement, so CLR integration may or may not be enabled. Nothing else changed."));
            }
            catch (SqlException sql)
            {
                var value = SsisErrors.FromSql(catalog, sql, connection, "master", "the server", "enable CLR integration");
                steps.Add(new("failed", value.Message));
                return new([.. steps, .. titles.Skip(1).Select(title => new ActionStepDto("skipped", title))], 0, value);
            }
        }
        // From here the job answers Stop itself, and the reply waits for it (ExecuteAsync): the restore runs to its end, because a
        // half-restored catalog is worse than waiting, and every later statement takes Stop, after which what was created goes.
        progress.Commit();
        var clr = enableClr ? " CLR integration stays enabled." : "";
        if (token.IsCancellationRequested)
            return new(steps, 0, Error("CANCELLED", "Create Catalog was stopped before its restore." + (steps.Count > 0 ? clr + " Nothing else changed." : " Nothing changed.")));

        var created = new CreatedObjects();
        var plan = new List<(string Title, Func<Task> Run)>
        {
            (titles[1], async () =>
            {
                created.Restored = true;
                await RunAsync(connection, SsisCreateSql.Restore,
                [
                    SsisCreate.Name("@catalog", name), SsisCreate.Path(catalog, "@backup", facts.BackupFile), SsisCreate.Name("@data_name", layout.DataName), SsisCreate.Path(catalog, "@data_file", facts.DataFile),
                    SsisCreate.Name("@second_name", layout.SecondName), SsisCreate.Path(catalog, "@second_file", layout.SecondName is null ? null : Path.ChangeExtension(facts.DataFile, ".ndf")),
                    SsisCreate.Name("@log_name", layout.LogName), SsisCreate.Path(catalog, "@log_file", facts.LogFile)
                ], CancellationToken.None);
                created.Recovered = true;
                // Part of the restore Stop waits for: ROLLBACK IMMEDIATE waits for no lock in a database nobody else could use yet.
                await RunAsync(connection, SsisCreateSql.ReadWrite, [SsisCreate.Name("@catalog", name)], CancellationToken.None);
            }),
            (titles[2], async () =>
            {
                await connection.ChangeDatabaseAsync(name, token);
                try { await RunAsync(connection, SsisCreateSql.MasterKey, [SsisCreate.Name("@password", action.Password)], token); }
                finally { if (connection.State == ConnectionState.Open) await connection.ChangeDatabaseAsync("master", CancellationToken.None); }
            })
        };
        if (!dryRun)
        {
            plan.Add((titles[3], async () =>
            {
                created.Assembly = true;
                await using (var command = Command(connection, SsisCreateSql.Assembly, [SsisCreate.Path(catalog, "@assembly", facts.AssemblyFile)]))
                await using (var reader = await command.ExecuteReaderAsync(token))
                {
                    if (await reader.ReadAsync(token) && !reader.IsDBNull(0) && reader.GetBoolean(0) && !reader.IsDBNull(1)) created.TrustedHash = (byte[])reader.GetValue(1);
                    while (await reader.NextResultAsync(token)) { }
                }
                created.Startup = true;
                await RunAsync(connection, SsisCreateSql.DropStartup, [], token);
                await RunAsync(connection, SsisCreateSql.CreateStartup, [], token);
                await RunAsync(connection, SsisCreateSql.StartupOn, [SsisCreate.StartupParameter(action)], token);
            }));
            plan.Add((titles[4], async () =>
            {
                created.Jobs = true;
                await RunAsync(connection, SsisCreateSql.CleanupLogin, [], token);
                await connection.ChangeDatabaseAsync(name, token);
                try { await RunAsync(connection, SsisCreateSql.CleanupUser, [], token); }
                finally { if (connection.State == ConnectionState.Open) await connection.ChangeDatabaseAsync("master", CancellationToken.None); }
                await RunAsync(connection, SsisCreateSql.CleanupGrant, [], token);
                await RunAsync(connection, SsisCreateSql.MaintenanceJob, [], token);
            }));
        }
        for (var index = 0; index < plan.Count; index++)
        {
            var (title, run) = plan[index];
            try
            {
                if (Options.BeforeCreateStep is { } before) await before(title);
                token.ThrowIfCancellationRequested();
                await run();
                steps.Add(new("done", title));
            }
            // Stop where SQL Server allows it: before the restore, or at any statement after it; a restore that fails is a failure.
            catch (Exception exception) when (token.IsCancellationRequested && (!created.Restored || created.Recovered) && exception is SqlException or OperationCanceledException)
            {
                if (!created.Restored) return new(steps, 0, Error("CANCELLED", "Create Catalog was stopped before its restore." + (steps.Count > 0 ? clr + " Nothing else changed." : " Nothing changed.")));
                steps.Add(new("cancelled", title));
                steps.AddRange(plan.Skip(index + 1).Select(item => new ActionStepDto("skipped", item.Title)));
                var removed = await RemoveAsync(connection, name, created, restoring: false, facts.Version);
                steps.Add(new(removed is null ? "done" : "failed", removed is null ? catalog.CleanupStep : catalog.CleanupStep + ": " + removed));
                return new(steps, 0, Error("CANCELLED", "Create Catalog was stopped at \"" + title + "\"" + (exception is SqlException ? "; SQL Server cancelled that statement." : ".") + Removed(name, removed, clr)));
            }
            catch (SqlException sql)
            {
                var exists = sql.Number == 27135;
                var value = exists ? Error("CATALOG_EXISTS", "There already exists a catalog (" + name + "), and only one catalog is supported on a server.")
                    : SsisErrors.FromSql(catalog, sql, connection, name, "the SSIS Catalog", "create the SSIS Catalog");
                steps.Add(new("failed", value.Message));
                steps.AddRange(plan.Skip(index + 1).Select(item => new ActionStepDto("skipped", item.Title)));
                // A refused restore made nothing; a failed one may have left the database restoring, which only this restore made.
                if (exists) return new(steps, 0, value);
                var removed = await RemoveAsync(connection, name, created, restoring: !created.Recovered, facts.Version);
                steps.Add(new(removed is null ? "done" : "failed", removed is null ? catalog.CleanupStep : catalog.CleanupStep + ": " + removed));
                return new(steps, 0, Error(value.Code, value.Message + Removed(name, removed, clr)));
            }
        }
        return new(steps, 0);
    }

    private static string Removed(string name, string? failure, string clr) => failure is null
        ? " Varia removed what Create Catalog had created, so the catalog does not exist." + clr
        : " Removing what Create Catalog had created failed too (" + failure + "): delete the " + name + " database, master.dbo.sp_ssis_startup, the SSIS Server Maintenance Job and the "
            + "##MS_SSISServerCleanupJobLogin## login before you try again.";

    /// <summary>SSMS's DropCatalogInternal after a Stop or a failed step, limited to what this Create Catalog made
    /// (<see cref="SsisCreate.Removal"/>). It cannot be stopped, so its statements wait at most 30 s for a lock (the cleanup
    /// prologue, which also ends a transaction a cancelled step left open). Each part runs even when one before it failed; null when
    /// all succeeded, otherwise what failed.</summary>
    private static async Task<string?> RemoveAsync(SqlConnection connection, string name, CreatedObjects created, bool restoring, string version)
    {
        if (connection.State != ConnectionState.Open) return "the connection to the server was lost";
        var failures = new List<string>();
        async Task Try(SsisCreateCommand command, SqlParameter[] parameters)
        {
            try { await RunAsync(connection, command, parameters, CancellationToken.None); }
            catch (SqlException error) { failures.Add(error.Message); }
        }
        await Try(SsisCreateSql.CleanupPrologue, []);
        try { if (connection.Database != "master") await connection.ChangeDatabaseAsync("master", CancellationToken.None); }
        catch (SqlException error) { return error.Message; }
        foreach (var (command, parameters) in SsisCreate.Removal(created, name, restoring, version)) await Try(command, parameters);
        return failures.Count == 0 ? null : string.Join(" ", failures.Distinct());
    }

    private static SqlCommand Command(SqlConnection connection, SsisCreateCommand template, SqlParameter[] parameters)
    {
        var command = connection.CreateCommand();
        command.CommandText = template.Text;
        command.CommandTimeout = 0;
        command.Parameters.AddRange(parameters);
        return command;
    }

    private static async Task RunAsync(SqlConnection connection, SsisCreateCommand template, SqlParameter[] parameters, CancellationToken token)
    {
        await using var command = Command(connection, template, parameters);
        await command.ExecuteNonQueryAsync(token);
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
