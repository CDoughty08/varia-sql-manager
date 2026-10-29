using Microsoft.Data.SqlClient;
using Varia.Backend.Explorer;
using Varia.Backend.Live;
using Varia.Backend.Protocol;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>A live host whose connections reach named servers and no SQL Server: its pools refuse (NOT_CONNECTED).</summary>
internal sealed class FixtureHost(Dictionary<string, string> servers, ResultStore store, ServerProfile? profile = null) : ILiveHost
{
    public bool TestHooks => false;
    public bool IsConnected(string connectionId) => servers.ContainsKey(connectionId);
    public string? ServerOf(string connectionId) => servers.GetValueOrDefault(connectionId);
    public ResultStore Store => store;
    public ServerProfile? Profile(string connectionId) => servers.ContainsKey(connectionId) ? profile : null;
    public SqlConnection PoolConnection(string connectionId, string? database, string suffix) => throw new RequestException("NOT_CONNECTED", "The fixture reaches no SQL Server.");
    public Task OpenAsync(SqlConnection connection, CancellationToken token) => throw new RequestException("NOT_CONNECTED", "The fixture reaches no SQL Server.");
}

/// <summary>Opens every probe and samples nothing.</summary>
internal sealed class IdleSampler : ILiveSampler
{
    public int? PeriodMs => null;
    public bool Ended => false;
    public Task<LiveOpening> OpenAsync(IReadOnlyList<LiveProbeState> probes, IReadOnlyList<LiveCursor> resume, CancellationToken token) =>
        Task.FromResult(new LiveOpening([.. probes.Select(probe => new LiveOpenedProbe(probe.Spec.Id, 1000, 1000, 1000, "ok"))]));
    public Task<LiveSampleBatch> SampleAsync(IReadOnlyList<LiveDue> due, CancellationToken token) => Task.FromResult(new LiveSampleBatch([], []));
    public void Apply(object args) { }
    public uint[] Keep() => [];
    public void Release() { }
    public void Dispose() { }
}

/// <summary>A sampler whose one sample is over the event limit (17 statuses of 128 characters would not be; this is bigger).</summary>
internal sealed class OversizedSampler : ILiveSampler
{
    public int? PeriodMs => 10;
    public bool Ended => false;
    public Task<LiveOpening> OpenAsync(IReadOnlyList<LiveProbeState> probes, IReadOnlyList<LiveCursor> resume, CancellationToken token) =>
        Task.FromResult(new LiveOpening([.. probes.Select(probe => new LiveOpenedProbe(probe.Spec.Id, 1000, 1000, 1000, "ok"))]));
    public Task<LiveSampleBatch> SampleAsync(IReadOnlyList<LiveDue> due, CancellationToken token) =>
        Task.FromResult(new LiveSampleBatch([new LiveSample(due[0].Probe.Spec.Id, 0, 1000, Status: [new LiveStatus("phase", new string('x', 300 * 1024))])], []));
    public void Apply(object args) { }
    public uint[] Keep() => [];
    public void Release() { }
    public void Dispose() { }
}

/// <summary>A sampler the scheduler checks script: how each probe opens, what each tick returns, how long a sample takes,
/// and a record of what the subscription asked of it.</summary>
internal sealed class ScriptedSampler(int? periodMs = 10) : ILiveSampler
{
    private int running;
    public Func<IReadOnlyList<LiveDue>, LiveSampleBatch> Next { get; set; } = due => new([.. due.Select(item => new LiveSample(item.Probe.Spec.Id, 0, 0))], []);
    /// <summary>Opened states by probe id; probes not named open ok.</summary>
    public Dictionary<string, LiveOpenedProbe> Opened { get; } = new(StringComparer.Ordinal);
    public int DelayMs { get; set; }
    public int Calls;
    public int Idles;
    public int MostAtOnce;
    public IReadOnlyList<LiveCursor>? ResumedFrom { get; private set; }
    public int? PeriodMs => periodMs;
    public bool Ended => false;

    public Task<LiveOpening> OpenAsync(IReadOnlyList<LiveProbeState> probes, IReadOnlyList<LiveCursor> resume, CancellationToken token)
    {
        ResumedFrom = resume;
        return Task.FromResult(new LiveOpening([.. probes.Select(probe => Opened.GetValueOrDefault(probe.Spec.Id) ?? new LiveOpenedProbe(probe.Spec.Id, probe.IntervalMs, 1000, 3_600_000, "ok"))]));
    }

    public async Task<LiveSampleBatch> SampleAsync(IReadOnlyList<LiveDue> due, CancellationToken token)
    {
        var now = Interlocked.Increment(ref running);
        InterlockedMax(ref MostAtOnce, now);
        Interlocked.Increment(ref Calls);
        try
        {
            if (DelayMs > 0) await Task.Delay(DelayMs, token);
            return Next(due);
        }
        finally { Interlocked.Decrement(ref running); }
    }

    private static void InterlockedMax(ref int target, int value)
    {
        int seen;
        while ((seen = Volatile.Read(ref target)) < value && Interlocked.CompareExchange(ref target, value, seen) != seen) { }
    }

    public void Idle() => Interlocked.Increment(ref Idles);
    public void Apply(object args) { }
    public uint[] Keep() => [];
    public void Release() { }
    public void Dispose() { }
}

/// <summary>A live.subscribe request context that records every credited EVENT and, unless told otherwise, acknowledges each
/// one at once (as the renderer would after applying it).</summary>
internal sealed class LiveRecorder : IDisposable
{
    private const int Length = 100;
    private readonly List<object> events = [];

    public LiveRecorder(uint id, bool acknowledge = true)
    {
        Acknowledge = acknowledge;
        Context = new RequestContext(id, "live.subscribe", RequestLane.Live, 0, 64 * 1024, sendCreditedEvent: (context, value) =>
        {
            lock (events) events.Add(value);
            // Granted from another thread: the context holds its lock while it sends.
            if (Acknowledge) _ = Task.Run(() => context.Grant(Length));
            return Length;
        });
    }

    public RequestContext Context { get; }
    public bool Acknowledge { get; set; }
    public void Grant() => Context.Grant(Length);

    public List<object> Events { get { lock (events) return [.. events]; } }
    public List<LiveTickEvent> Ticks => [.. Events.OfType<LiveTickEvent>()];
    public LiveOpenedEvent? Opened => Events.OfType<LiveOpenedEvent>().FirstOrDefault();

    /// <summary>Waits until the recorded events satisfy the condition, or the timeout passes.</summary>
    public async Task<bool> WaitAsync(Func<LiveRecorder, bool> condition, int timeoutMs = 10_000)
    {
        var deadline = Environment.TickCount64 + timeoutMs;
        while (!condition(this))
        {
            if (Environment.TickCount64 > deadline) return false;
            await Task.Delay(20);
        }
        return true;
    }

    public void Dispose() => Context.Dispose();
}

/// <summary>A live host whose one connection id reaches a server that never finishes a login: OpenAsync waits until its
/// token is cancelled. It counts the pool connections handed out and the opens started.</summary>
internal sealed class HangingHost(string connectionId) : ILiveHost
{
    public int Pooled;
    public int Opens;
    public bool TestHooks => false;
    public bool IsConnected(string id) => id == connectionId;
    public string? ServerOf(string id) => id == connectionId ? "server:H" : null;
    public ResultStore Store { get; } = new(1L << 20, 1L << 19);
    public ServerProfile? Profile(string id) => id == connectionId ? new(16, null, 3, null, false, true, false) : null;

    public SqlConnection PoolConnection(string id, string? database, string suffix)
    {
        Interlocked.Increment(ref Pooled);
        return new SqlConnection("Data Source=varia-fixture.invalid;Integrated Security=true;Pooling=false");
    }

    public async Task OpenAsync(SqlConnection connection, CancellationToken token)
    {
        Interlocked.Increment(ref Opens);
        await Task.Delay(Timeout.Infinite, token);
    }
}

/// <summary>A live host whose one connection id opens as <see cref="Open"/> says: each connection unpooled, its Database the one
/// asked for (empty for the login's own), and never reaching a SQL Server.</summary>
internal sealed class ScriptedOpenHost(string connectionId) : ILiveHost
{
    public Func<SqlConnection, CancellationToken, Task> Open { get; set; } = (_, _) => Task.CompletedTask;
    public bool TestHooks => false;
    public bool IsConnected(string id) => id == connectionId;
    public string? ServerOf(string id) => id == connectionId ? "server:S" : null;
    public ResultStore Store { get; } = new(1L << 20, 1L << 19);
    public ServerProfile? Profile(string id) => id == connectionId ? new(16, null, 3, null, false, true, false) : null;
    public SqlConnection PoolConnection(string id, string? database, string suffix) =>
        new(new SqlConnectionStringBuilder { DataSource = "varia-fixture.invalid", IntegratedSecurity = true, Pooling = false, InitialCatalog = database ?? "" }.ConnectionString);
    public Task OpenAsync(SqlConnection connection, CancellationToken token) => Open(connection, token);
}
