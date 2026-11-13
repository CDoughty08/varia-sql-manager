using Varia.Backend.Results;
using Gate = Varia.Backend.Results.ViewSorter.WorkerGate;

namespace Varia.Backend.Tests;

/// <summary>How result operations share the worker threads (docs/ipc.md, "Worker threads"): fair shares, threads handed
/// back between items, the bound on threads, and the parallel loop the operations run their steps through. The sharing
/// checks start no thread: the gate's workers are recorded, not run, and each step is driven by hand.</summary>
internal static class WorkerGateChecks
{
    /// <summary>A step whose workers only begin: each is then driven by hand.</summary>
    private sealed class Probe(Gate.Lease owner) : Gate.Loop
    {
        public bool Began;
        public override void Execute() => Began = owner.Begin(this);
    }

    /// <summary>A gate whose workers are recorded and begun at once, on the caller's thread.</summary>
    private static Gate Recording(int limit, List<IThreadPoolWorkItem> started) => new(() => limit, item =>
    {
        started.Add(item);
        item.Execute();
    });

    public static void Run(Action<bool, string> check)
    {
        Shares(check);
        Unstarted(check);
        QueuedFirst(check);
        Refused(check);
        Crowded(check);
        Loops(check);
    }

    private static void Shares(Action<bool, string> check)
    {
        var started = new List<IThreadPoolWorkItem>();
        var gate = Recording(8, started);
        int Started(Gate.Loop step) => started.Count(item => item == step);

        // Alone, an operation has every thread: its own and seven workers.
        var a = gate.Take(8);
        var admitted = a.Count;
        var first = new Probe(a);
        a.Open(first, 8);
        var alone = (admitted, a.Count, Started(first), gate.Busy);

        // A second operation started beside it has its own thread at once, and half the threads as the first's workers
        // reach their next item: four hand theirs back, each going to the second, and the other three keep going.
        var b = gate.Take(8);
        var second = new Probe(b);
        var secondAdmitted = b.Count;
        b.Open(second, 8);
        var shares = (a.Target, b.Target, Started(second));
        var kept = 0;
        for (var worker = 0; worker < 7; worker++)
            if (a.Keep()) kept++;
        var split = (kept, a.Count, b.Count, Started(second), gate.Busy);
        check(alone == (8, 8, 7, 8) && secondAdmitted == 1 && shares == (4, 4, 0) && split == (3, 4, 4, 3, 8) && gate.Peak == 9,
            "an operation alone takes every thread; one started beside it gets half as the first's workers hand theirs back between items, never more busy than the limit and the second's own thread: "
            + alone + " " + secondAdmitted + " " + shares + " " + split + " peak " + gate.Peak);

        // The second's step runs out of items: as each of its workers leaves, the first's share grows and a worker starts
        // for it; once the second is done the first has every thread again.
        for (var worker = 0; worker < 3; worker++) b.Exit();
        var growing = (a.Count, a.Target, Started(first));
        b.Close();
        b.Dispose();
        var regained = (a.Count, a.Target, Started(first), gate.Busy);
        check(growing == (7, 7, 10) && regained == (8, 8, 11, 8),
            "threads an operation hands back go to the one below its share, up to every thread once it is alone again: " + growing + " " + regained);

        // A step of two items takes two threads, and the others split the rest.
        for (var worker = 0; worker < 7; worker++) a.Exit();
        a.Close();
        var small = new Probe(a);
        a.Open(small, 2);
        var c = gate.Take(8);
        var filled = (a.Count, a.Target, c.Target, c.Count);
        c.Dispose();
        a.Exit();
        a.Close();
        a.Dispose();
        check(filled == (2, 2, 6, 6) && gate.Busy == 0 && a.Count == 0,
            "shares are filled from the smallest demand up: a step of two items takes two, the other operation the remaining six; every thread is given back: " + filled + " busy " + gate.Busy);
    }

    private static void Unstarted(Action<bool, string> check)
    {
        // Workers the thread pool has not yet run when their step closes go back at once, and do nothing when they run.
        var queued = new List<IThreadPoolWorkItem>();
        var gate = new Gate(() => 4, queued.Add);
        var lease = gate.Take(4);
        var step = new Probe(lease);
        lease.Open(step, 4);
        var open = (lease.Count, gate.Busy, queued.Count);
        lease.Close();
        var closed = (lease.Count, gate.Busy, step.Pending);
        foreach (var item in queued) item.Execute();
        var late = (step.Began, lease.Count, gate.Busy);
        lease.Dispose();
        check(open == (4, 4, 3) && closed == (1, 1, 0) && late == (false, 1, 1) && gate.Busy == 0,
            "a step's owner never waits for workers the thread pool has not run: closing gives their threads back, and they do nothing when they run: " + open + " " + closed + " " + late);
    }

    private static void QueuedFirst(Action<bool, string> check)
    {
        // Over its share, a lease hands back a worker the thread pool has not run before one that is running: the running
        // one goes on to its next item.
        var queued = new List<IThreadPoolWorkItem>();
        var gate = new Gate(() => 4, queued.Add);
        var a = gate.Take(4);
        var first = new Probe(a);
        a.Open(first, 4);
        var b = gate.Take(4);
        b.Open(new Probe(b), 4);
        queued[0].Execute();
        var kept = (a.Keep(), a.Keep(), a.Keep());
        var after = (a.Count, b.Count, first.Pending, first.Queued, gate.Busy);
        a.Exit();
        a.Close();
        b.Close();
        a.Dispose();
        b.Dispose();
        check(first.Began && kept == (true, true, true) && after == (2, 2, 1, 0, 4) && gate.Busy == 0,
            "a lease over its share hands back the workers still queued before one that is running: " + kept + " " + after);
    }

    private static void Refused(Action<bool, string> check)
    {
        // A thread pool that refuses a worker (a callback that throws) leaves the step to its owner and the others: every
        // item still runs once, nothing is counted twice, and no exception reaches a worker or the owner.
        var calls = 0;
        var gate = new Gate(() => 4, item =>
        {
            if (Interlocked.Increment(ref calls) % 2 == 0) throw new InvalidOperationException("refused");
            ThreadPool.UnsafeQueueUserWorkItem(item, preferLocal: false);
        });
        var runs = new int[2000];
        string? failed = null;
        try
        {
            for (var round = 0; round < 20; round++)
                using (var lease = gate.Take(4)) lease.For(100, index => Interlocked.Increment(ref runs[round * 100 + index]));
        }
        catch (Exception error) { failed = error.Message; }
        var refusing = new Gate(() => 4, _ => throw new InvalidOperationException("refused"));
        var alone = 0;
        int held;
        using (var lease = refusing.Take(4))
        {
            lease.For(50, _ => alone++);
            held = lease.Count;
        }
        check(failed is null && runs.All(count => count == 1) && calls > 1 && gate.Busy == 0 && alone == 50 && held == 1 && refusing.Busy == 0,
            "a worker the thread pool refuses is taken back: the items still run once each on the threads there are, and every thread is given back (" + failed + ")");
    }

    private static void Crowded(Action<bool, string> check)
    {
        // More operations than threads: each keeps its own and a share of one, no worker starts past the limit, and the
        // first's surplus worker hands its thread back.
        var started = new List<IThreadPoolWorkItem>();
        var gate = Recording(2, started);
        var leases = Enumerable.Range(0, 5).Select(_ => gate.Take(4)).ToArray();
        var steps = leases.Select(lease =>
        {
            var step = new Probe(lease);
            lease.Open(step, 4);
            return step;
        }).ToArray();
        var startedBefore = started.Count;
        var handedBack = !leases[0].Keep();
        var state = (Targets: string.Join(",", leases.Select(lease => lease.Target)), Counts: string.Join(",", leases.Select(lease => lease.Count)), gate.Busy);
        foreach (var lease in leases) lease.Close();
        foreach (var lease in leases) lease.Dispose();
        check(startedBefore == 1 && handedBack && state == ("1,1,1,1,1", "1,1,1,1,1", 5) && started.Count == 1 && gate.Busy == 0 && gate.Peak == 6,
            "more operations than threads each keep their own thread and a share of one; none starts a worker while the threads are taken: " + state + " started " + started.Count + " peak " + gate.Peak);
    }

    private static void Loops(Action<bool, string> check)
    {
        // The real loop on real threads: every item runs once, the first failure is rethrown as itself once every worker
        // has stopped, a cancellation likewise, and every thread is given back.
        var gate = new Gate(() => 4);
        var runs = new int[5000];
        using (var lease = gate.Take(4)) lease.For(runs.Length, index => Interlocked.Increment(ref runs[index]));
        string? failed = null;
        var heldAfterFailure = -1;
        using (var lease = gate.Take(4))
        {
            try { lease.For(5000, index => { if (index == 2500) throw new InvalidOperationException("item"); }); }
            catch (InvalidOperationException error) { failed = error.Message; }
            heldAfterFailure = lease.Count;
        }
        string? canceled = null;
        var ran = 0;
        using (var cancel = new CancellationTokenSource())
        using (var lease = gate.Take(4))
        {
            try
            {
                lease.For(5000, index =>
                {
                    if (Interlocked.Increment(ref ran) == 100) cancel.Cancel();
                }, cancel.Token);
            }
            catch (OperationCanceledException) { canceled = "canceled"; }
        }
        // Two operations at once, each through its own step: both finish, and the threads stay within the limit and the
        // second's own thread.
        var both = new int[2];
        Parallel.For(0, 2, new ParallelOptions { MaxDegreeOfParallelism = 2 }, which =>
        {
            using var lease = gate.Take(4);
            for (var step = 0; step < 20; step++) lease.For(64, _ => Interlocked.Increment(ref both[which]));
        });
        var states = 0;
        using (var lease = gate.Take(4)) lease.For(64, () => Interlocked.Increment(ref states), (_, _) => { }, CancellationToken.None);
        check(runs.All(count => count == 1) && failed == "item" && heldAfterFailure == 1 && canceled == "canceled" && ran < 5000 && both is [1280, 1280]
            && states is >= 1 and <= 4 && gate.Busy == 0 && gate.Peak <= 5,
            "a step's items each run once on the gate's threads; a failure or cancellation is rethrown after its workers stop, and every thread is given back (peak " + gate.Peak + ", ran " + ran + ", states " + states + ")");
    }
}
