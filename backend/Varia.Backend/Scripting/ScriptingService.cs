using System.Collections.Concurrent;
using System.Data;
using System.Diagnostics;
using Microsoft.Data.SqlClient;
using Microsoft.SqlServer.Management.Smo;
using Varia.Backend.Common;
using Varia.Backend.Explorer;

namespace Varia.Backend.Scripting;

/// <summary>What the service needs from SqlService: a connection's profile and its scripting pool.</summary>
internal interface IScriptingHost
{
    /// <summary>Throws NOT_CONNECTED for an unknown connection.</summary>
    ServerProfile Profile(string connectionId);
    /// <summary>An unopened connection from the connection's scripting pool; with a database, a pool in that database
    /// (cloud editions, which cannot switch databases).</summary>
    SqlConnection Connection(string connectionId, string? database);
    /// <summary>Opens one of those connections; a Kerberos token failure throws AUTH_KERBEROS (or AUTH_UNSUPPORTED), which the
    /// job answers as its error value.</summary>
    Task OpenAsync(SqlConnection connection, CancellationToken token);
}

/// <summary>Limits and test seams (live checks set the internal ones through InternalsVisibleTo).</summary>
internal sealed class ScriptingServiceOptions
{
    public int PerConnection { get; init; } = 2;
    public int Total { get; init; } = 4;
    public int MaxRegistered { get; init; } = 256;
    /// <summary>The job's own time limit, inside main's 60 s deadline: past it the answer is a TIMEOUT value.</summary>
    public TimeSpan Budget { get; set; } = TimeSpan.FromSeconds(55);
    /// <summary>Holds every preflight statement in WAITFOR DELAY (cancellation checks).</summary>
    public TimeSpan? PreflightDelay { get; set; }
    /// <summary>Reads the session's state as the job hands its connection back to the pool (live checks).</summary>
    internal Func<SqlConnection, Task>? Released { get; set; }
    /// <summary>Runs on the SMO thread with the target's database just before Generate script for dependent objects
    /// walks its dependencies (live checks take the database offline there, after the preflight read it).</summary>
    internal Action<string>? BeforeDependencies { get; set; }
    /// <summary>Runs on the SMO thread with the target's database after the definition check, just before SMO's Scripter
    /// (live checks take a dependent's or the target's database offline there).</summary>
    internal Action<string>? BeforeScript { get; set; }
}

/// <summary>scripting.script (spec C1): validate, register, take the connection's and the global gate, open a scripting
/// pool connection, run the preflight, then SMO on a dedicated thread. Failures are values; a cancelled request (CANCEL
/// frame, deadline, disconnect) throws. The reply never waits for SMO: the request awaits the job with its token, and the
/// job alone owns the connection and the gates until its thread ends, so abandoned SMO work holds only its gate.</summary>
internal sealed class ScriptingService : IDisposable
{
    private readonly IScriptingHost host;
    private readonly ScriptingCatalog catalog;
    private readonly ExplorerCatalog explorer;
    private readonly RequestRegistry running;
    private readonly ConcurrentDictionary<string, SemaphoreSlim> gates = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim total;

    public ScriptingService(IScriptingHost host, ScriptingServiceOptions? options = null, ScriptingCatalog? catalog = null, ExplorerCatalog? explorer = null)
    {
        this.host = host;
        Options = options ?? new ScriptingServiceOptions();
        this.catalog = catalog ?? ScriptingCatalog.Current;
        this.explorer = explorer ?? ExplorerCatalog.Current;
        total = new SemaphoreSlim(Options.Total);
        running = new RequestRegistry(Options.MaxRegistered, "scripting");
    }

    public ScriptingServiceOptions Options { get; }
    public ScriptingCatalog Catalog => catalog;
    /// <summary>Requests registered and not yet answered.</summary>
    public int RunningCount => running.Count;
    /// <summary>Jobs holding a gate: answered requests whose SMO thread has not ended yet count too.</summary>
    public int ActiveJobs => Options.Total - total.CurrentCount;

    private static RequestException Invalid(string detail) => new("INVALID_PARAMS", "Invalid scripting request: " + detail);

    /// <summary>Re-validates what main's zod schema (src/shared/scripting/schema.ts) accepts: ids, one target of a
    /// scriptable kind, a verb some row of that kind enables, and every option's value.</summary>
    public (ObjectRefDto Target, ScriptVerbRow Verb) Validate(ScriptArgs args)
    {
        if (!Guid.TryParse(args.ConnectionId, out _)) throw Invalid("connectionId.");
        if (!Guid.TryParse(args.RequestId, out _)) throw Invalid("requestId.");
        if (args.Targets is not { Count: 1 } || args.Targets[0] is not { } target) throw Invalid("exactly one target is required.");
        try { ExplorerRefs.Object(target, explorer); }
        catch (RequestException) { throw Invalid("target."); }
        var verb = (args.Verb is null ? null : catalog.Verb(args.Verb)) ?? throw Invalid("verb.");
        if (!catalog.Targets.Any(row => row.Kind == target.Kind && row.Scriptable && row.Enabled.Contains(verb.Id) && (row.Parents.Count == 0) == (target.Parent is null)
            && (target.Parent is null || row.Parents.Contains(target.Parent.Kind))))
            throw Invalid("this object cannot be scripted with this verb.");
        var options = args.Options ?? throw Invalid("options.");
        foreach (var (row, value) in catalog.Options.Where(row => row.Type == "enum").Select(row => (row, OptionValue(options, row.Key))))
            if (!row.Values.Contains(value)) throw Invalid("option " + row.Key + ".");
        return (target, verb);
    }

    private static string OptionValue(ScriptingOptionsDto options, string key) => key switch
    {
        "targetEngineEdition" => options.TargetEngineEdition,
        "targetEngineType" => options.TargetEngineType,
        "targetServerVersion" => options.TargetServerVersion,
        _ => throw new InvalidOperationException("Unknown enum option " + key)
    };

    public async Task<ScriptResult> ScriptAsync(ScriptArgs args, CancellationToken token)
    {
        var watch = Stopwatch.StartNew();
        var (target, verb) = Validate(args);
        var profile = host.Profile(args.ConnectionId);
        var database = ScriptPreflight.ServerScope(target.Kind) ? "master" : target.Database!;
        using var source = CancellationTokenSource.CreateLinkedTokenSource(token);
        var entry = running.Register(args.RequestId, args.ConnectionId, source);
        try
        {
            // A request cancelled before it ran (a CANCEL frame read right after its REQUEST) takes no gate.
            token.ThrowIfCancellationRequested();
            source.CancelAfter(Options.Budget);
            // The job owns its token source and tracker and disposes them when its work really ends.
            var jobSource = CancellationTokenSource.CreateLinkedTokenSource(source.Token);
            var tracked = new TrackedJob(jobSource.Token);
            // Started on the pool, so nothing the job does synchronously can delay the reply.
            var job = Task.Run(() => RunAsync(args.ConnectionId, target, verb, args.Options, profile, database, tracked, jobSource), CancellationToken.None);
            _ = job.ContinueWith(done => _ = done.Exception, CancellationToken.None, TaskContinuationOptions.OnlyOnFaulted, TaskScheduler.Default);
            try { return (await job.WaitAsync(source.Token)) with { ElapsedMs = watch.ElapsedMilliseconds }; }
            catch (OperationCanceledException) when (source.IsCancellationRequested && !token.IsCancellationRequested)
            {
                if (entry.Forgotten) throw new RequestException("CANCELLED", "The operation was cancelled.");
                var subject = ScriptPreflight.Subject(catalog, target, verb, database);
                return new(null, database, [], tracked.Commands, watch.ElapsedMilliseconds, ScriptingErrors.Create(catalog, "TIMEOUT", subject));
            }
        }
        finally { running.Unregister(args.RequestId, entry); }
    }

    private async Task<ScriptResult> RunAsync(string connectionId, ObjectRefDto target, ScriptVerbRow verb, ScriptingOptionsDto options, ServerProfile profile, string database,
        TrackedJob tracked, CancellationTokenSource jobSource)
    {
        try
        {
            var token = jobSource.Token;
            using var scope = CommandTracker.Track(tracked);
            var gate = gates.GetOrAdd(connectionId, _ => new SemaphoreSlim(Options.PerConnection));
            await gate.WaitAsync(token);
            try
            {
                await total.WaitAsync(token);
                try { return await ExecuteAsync(connectionId, target, verb, options, profile, database, tracked, token); }
                finally { total.Release(); }
            }
            finally { gate.Release(); }
        }
        finally
        {
            tracked.Dispose();
            jobSource.Dispose();
        }
    }

    private async Task<ScriptResult> ExecuteAsync(string connectionId, ObjectRefDto target, ScriptVerbRow verb, ScriptingOptionsDto options, ServerProfile profile, string database,
        TrackedJob tracked, CancellationToken token)
    {
        var served = profile.Explorer(explorer);
        var subject = ScriptPreflight.Subject(catalog, target, verb, database);
        ScriptResult Result(string? text, IReadOnlyList<string> warnings, ScriptError? error = null) =>
            new(text, database, [.. warnings.Take(8).Select(warning => ScriptingErrors.Clip(warning, 512))], tracked.Commands, 0, error);
        // Cloud databases are reached one per connection, and have no server-level objects to script.
        if (served.Cloud && ScriptPreflight.ServerScope(target.Kind) && target.Kind != "database") return Result(null, [], ScriptingErrors.Create(catalog, "NOT_SUPPORTED", subject));
        var perDatabase = served.Cloud && !ScriptPreflight.ServerScope(target.Kind);
        await using var connection = host.Connection(connectionId, perDatabase ? target.Database : null);
        string? home = null;
        ResolvedTarget? resolved = null;
        SmoScriptRunner? runner = null;
        try
        {
            await host.OpenAsync(connection, token);
            home = connection.Database;
            await using (var prologue = connection.CreateCommand())
            {
                prologue.CommandText = ScriptPreflight.Prologue;
                prologue.CommandTimeout = 30;
                await prologue.ExecuteNonQueryAsync(token);
            }
            var preflight = await ScriptPreflight.RunAsync(connection, catalog, target, verb, served.Band, perDatabase, Options.PreflightDelay, token, profile.VectorDimensions);
            if (preflight.Error is { } refused) return Result(null, preflight.Warnings, refused);
            resolved = preflight.Target!;
            var session = new ScriptSession(connection, profile, served.Cloud);
            var job = new ScriptJob(connectionId, [resolved], verb, options);
            var sink = new StringScriptSink(catalog.Limit("maxScriptChars"));
            var smo = runner = new SmoScriptRunner(session, token) { BeforeDependencies = Options.BeforeDependencies, BeforeScript = Options.BeforeScript };
            // SMO blocks for whole round trips, so it gets a thread of its own; the tracker on this flow follows it there.
            // Templates only format the preflight's rows.
            var warnings = verb.Class != VerbClass.Ddl ? ScriptPipeline.Run(job, smo, sink, token, served.Cloud)
                : await Task.Factory.StartNew(() => ScriptPipeline.Run(job, smo, sink, token, served.Cloud), CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
            var text = sink.ToString();
            if (ScriptingErrors.UnpairedSurrogate(text) >= 0) return Result(null, [], ScriptingErrors.Create(catalog, "UNREPRESENTABLE", subject));
            return Result(text, [.. preflight.Warnings, .. warnings]);
        }
        catch (RequestException error) when (error.Code is "AUTH_KERBEROS" or "AUTH_UNSUPPORTED")
        {
            // The pool connection could not sign in with Kerberos (an expired ticket, say): the advice is the job's error
            // value, as Object Explorer shows it on the node, and Script As works again after kinit.
            return Result(null, [], ScriptingErrors.Create(catalog, error.Code, subject, error.Message));
        }
        catch (Exception error) when (!token.IsCancellationRequested && ScriptingErrors.Classify(catalog, error, subject, resolved?.Encrypted == true, runner?.Target,
            target.Kind is "serverTrigger" or "databaseTrigger", connection.State is ConnectionState.Broken or ConnectionState.Closed && home is not null) is { } value)
        {
            return Result(null, [], value);
        }
        finally
        {
            // SMO switches databases with USE; an idle pooled connection must not hold the object's database open.
            if (home is not null && connection.State == ConnectionState.Open && connection.Database != home)
            {
                try { await connection.ChangeDatabaseAsync(home, CancellationToken.None); }
                catch (Exception error) when (error is SqlException or InvalidOperationException) { /* The pool discards a connection it cannot reset. */ }
            }
            if (Options.Released is { } released && connection.State == ConnectionState.Open) await released(connection);
        }
    }

    /// <summary>Cancels a disconnected connection's jobs and drops its gate.</summary>
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
