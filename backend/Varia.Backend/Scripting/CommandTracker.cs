using System.Diagnostics;
using Microsoft.Data.SqlClient;
using Microsoft.Data.SqlClient.Diagnostics;

namespace Varia.Backend.Scripting;

/// <summary>One scripting job as the tracker sees it: its token, the command in flight, and how many it sent.</summary>
internal sealed class TrackedJob : IDisposable
{
    private readonly CancellationTokenRegistration registration;
    private SqlCommand? command;
    private int commands;

    public TrackedJob(CancellationToken token)
    {
        Token = token;
        // An attention on the statement in flight stops the server's work within one round trip.
        registration = token.Register(Attention);
    }

    public CancellationToken Token { get; }
    public int Commands => Volatile.Read(ref commands);

    internal void Started(SqlCommand value)
    {
        // A cancelled job sends nothing more: SMO's next statement fails before it reaches the server.
        Token.ThrowIfCancellationRequested();
        Volatile.Write(ref command, value);
        Interlocked.Increment(ref commands);
        if (Token.IsCancellationRequested) Attention();
    }

    internal void Ended(SqlCommand value) => Interlocked.CompareExchange(ref command, null, value);

    private void Attention()
    {
        try { Volatile.Read(ref command)?.Cancel(); }
        catch (Exception error) when (error is InvalidOperationException or SqlException or ObjectDisposedException) { /* The command ended. */ }
    }

    public void Dispose() => registration.Dispose();
}

/// <summary>SMO has no public cancel, and its statements run on our connection out of our sight. SqlClient announces each
/// command through its DiagnosticListener, so the tracker records the command of the scripting job running on the
/// current flow (an AsyncLocal, set only by scripting jobs), counts it, and cancels it on request. Other commands only
/// cost the AsyncLocal read in IsEnabled. If SqlClient's event contract changes, Commands stays 0 and cancellation falls
/// back to the token checks and timeouts (a live check fails loudly).</summary>
internal static class CommandTracker
{
    public const string ListenerName = "SqlClientDiagnosticListener";
    private const string Before = "Microsoft.Data.SqlClient.WriteCommandBefore", After = "Microsoft.Data.SqlClient.WriteCommandAfter",
        Error = "Microsoft.Data.SqlClient.WriteCommandError";
    private static readonly AsyncLocal<TrackedJob?> Current = new();
    private static int started;

    /// <summary>Makes the job current on this flow (and the tasks and threads it starts) until disposed.</summary>
    public static IDisposable Track(TrackedJob job)
    {
        Start();
        var previous = Current.Value;
        Current.Value = job;
        return new Scope(previous);
    }

    private static void Start()
    {
        // A process-wide subscription, kept for the life of the backend.
        if (Interlocked.Exchange(ref started, 1) == 0) _ = DiagnosticListener.AllListeners.Subscribe(new Listeners());
    }

    private sealed class Scope(TrackedJob? previous) : IDisposable
    {
        public void Dispose() => Current.Value = previous;
    }

    private sealed class Listeners : IObserver<DiagnosticListener>
    {
        public void OnNext(DiagnosticListener listener)
        {
            if (listener.Name == ListenerName) listener.Subscribe(new Events(), (name, _, _) => Current.Value is not null && name is Before or After or Error);
        }
        public void OnCompleted() { }
        public void OnError(Exception error) { }
    }

    private sealed class Events : IObserver<KeyValuePair<string, object?>>
    {
        public void OnNext(KeyValuePair<string, object?> value)
        {
            if (Current.Value is not { } job) return;
            switch (value.Value)
            {
                case SqlClientCommandBefore before: job.Started(before.Command); break;
                case SqlClientCommandAfter after: job.Ended(after.Command); break;
                case SqlClientCommandError error: job.Ended(error.Command); break;
            }
        }
        public void OnCompleted() { }
        public void OnError(Exception error) { }
    }
}
