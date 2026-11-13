using System.Runtime.ExceptionServices;

namespace Varia.Backend.Results;

internal static partial class ViewSorter
{
    /// <summary>The threads the results' operations share (<see cref="Workers"/> of them), handed out in fair shares. Each
    /// operation takes a lease, which always keeps its own thread (the request's), and runs its parallel steps through
    /// <see cref="Lease.For{TState}"/>: the step's items (pages, runs of pages, slices, merges) are taken one at a time by
    /// the lease's workers. The gate gives each lease a share of the threads by what its step can use (shares are filled
    /// from the smallest demand up, so a step of two items takes two and the rest split what is left), starts workers only
    /// while fewer than <see cref="Workers"/> threads are busy, and between two items a worker of a lease holding more than
    /// its share hands its thread back, which goes to the lease furthest below its share. So an operation alone has every
    /// thread, a second one started beside it has half of them after the first's next items rather than the leftovers at
    /// the end, and no lease ever has none.</summary>
    internal sealed class WorkerGate(Func<int> limit, Action<IThreadPoolWorkItem>? start = null)
    {
        private readonly Lock sync = new();
        private readonly List<Lease> leases = [];
        private readonly Action<IThreadPoolWorkItem> start = start ?? (item => ThreadPool.UnsafeQueueUserWorkItem(item, preferLocal: false));
        private int busy, peak;

        /// <summary>Threads the leases hold: each one's own and the workers started for it.</summary>
        public int Busy => Volatile.Read(ref busy);
        /// <summary>The most threads held at once.</summary>
        public int Peak => Volatile.Read(ref peak);
        private int Limit => Math.Max(1, limit());

        /// <summary>A lease for an operation that would use <paramref name="wanted"/> threads: its own, and as many of its
        /// share as are free now (<see cref="Lease.Count"/>).</summary>
        public Lease Take(int wanted)
        {
            var lease = new Lease(this, Math.Max(1, wanted));
            lease.demand = lease.Wanted;
            lock (sync)
            {
                leases.Add(lease);
                Share();
                Hold(lease, Math.Max(1, Math.Min(lease.target, Limit - busy)));
            }
            return lease;
        }

        private void Hold(Lease lease, int count)
        {
            lease.held += count;
            busy += count;
            if (busy > peak) peak = busy;
        }

        private void Free(Lease lease, int count)
        {
            lease.held -= count;
            busy -= count;
        }

        /// <summary>Each lease's share of the threads: filled from the smallest demand up, each the lesser of its demand
        /// and an even split of what is left, and one at least.</summary>
        private void Share()
        {
            leases.Sort(static (a, b) => a.demand.CompareTo(b.demand));
            var left = Limit;
            for (var i = 0; i < leases.Count; i++)
            {
                var lease = leases[i];
                lease.target = Math.Max(1, Math.Min(lease.demand, left / (leases.Count - i)));
                left -= lease.target;
            }
        }

        /// <summary>While threads are free, a worker for the open step furthest below its share.</summary>
        private void Grant(List<Loop> started)
        {
            while (busy < Limit)
            {
                Lease? furthest = null;
                var most = 0;
                foreach (var lease in leases)
                    if (lease.loop is { Open: true } && Math.Min(lease.target, lease.demand) - lease.held > most)
                        (furthest, most) = (lease, Math.Min(lease.target, lease.demand) - lease.held);
                if (furthest is null) return;
                Hold(furthest, 1);
                furthest.loop!.Pending++;
                furthest.loop.Queued++;
                started.Add(furthest.loop);
            }
        }

        private void Start(List<Loop>? started)
        {
            if (started is null) return;
            foreach (var loop in started) start(loop);
        }

        /// <summary>A step's workers: the gate counts those started and not yet gone (<see cref="Pending"/>), of them those
        /// queued to the thread pool and not yet running (<see cref="Queued"/>), and signals the step's owner when its items
        /// have all been taken and the last has gone. Each worker begins with <see cref="Lease.Begin"/>.</summary>
        internal abstract class Loop : IThreadPoolWorkItem
        {
            internal bool Open;
            internal int Pending, Queued;
            internal ManualResetEventSlim? Done;
            public abstract void Execute();
        }

        internal sealed class Lease(WorkerGate gate, int wanted) : IDisposable
        {
            internal int held, target, demand = int.MaxValue;
            internal Loop? loop;
            private bool disposed;

            /// <summary>The threads the operation would use.</summary>
            public int Wanted => wanted;
            /// <summary>The threads it holds now: its own and its workers'.</summary>
            public int Count => Volatile.Read(ref held);
            /// <summary>Its share now.</summary>
            public int Target => Volatile.Read(ref target);

            /// <summary>Opens a step that can use <paramref name="threads"/> threads: the ones the lease holds become its
            /// workers (any past the step's use are handed back), and more are started up to its share while free.</summary>
            internal void Open(Loop step, int threads)
            {
                var started = new List<Loop>();
                lock (gate.sync)
                {
                    loop = step;
                    step.Open = true;
                    demand = Math.Max(1, threads);
                    gate.Share();
                    if (held > demand) gate.Free(this, held - demand);
                    step.Pending += held - 1;
                    step.Queued += held - 1;
                    for (var i = 1; i < held; i++) started.Add(step);
                    gate.Grant(started);
                }
                gate.Start(started);
            }

            /// <summary>A worker of <paramref name="step"/> begins on its thread: false when the step's owner has already
            /// closed it and handed its thread back, so the worker does nothing.</summary>
            internal bool Begin(Loop step)
            {
                lock (gate.sync)
                {
                    if (step.Queued == 0) return false;
                    step.Queued--;
                    return true;
                }
            }

            /// <summary>Asked by a started worker between two items: false when the lease holds more than its share, and
            /// the worker's thread has been handed back.</summary>
            internal bool Keep()
            {
                if (Volatile.Read(ref held) <= Volatile.Read(ref target)) return true;
                List<Loop>? started = null;
                lock (gate.sync)
                {
                    if (held <= target) return true;
                    Leave();
                    gate.Grant(started = []);
                }
                gate.Start(started);
                return false;
            }

            /// <summary>A started worker that found no item left (or a failure): its thread is handed back, and the step
            /// wants no more than the threads still on it.</summary>
            internal void Exit()
            {
                var started = new List<Loop>();
                lock (gate.sync)
                {
                    Leave();
                    if (loop!.Open && held < demand)
                    {
                        demand = Math.Max(1, held);
                        gate.Share();
                    }
                    gate.Grant(started);
                }
                gate.Start(started);
            }

            private void Leave()
            {
                gate.Free(this, 1);
                if (--loop!.Pending == 0 && !loop.Open) loop.Done?.Set();
            }

            /// <summary>The owner's thread found no item left: no more workers start for the step, and the lease wants its
            /// own thread only until its next step.</summary>
            internal void Close()
            {
                var started = new List<Loop>();
                lock (gate.sync)
                {
                    loop!.Open = false;
                    // Workers still queued would find nothing to do: their threads go back now, so the owner never waits
                    // for a thread pool short of threads to run them (Parallel.For runs such work on the waiting thread).
                    if (loop.Queued > 0)
                    {
                        gate.Free(this, loop.Queued);
                        loop.Pending -= loop.Queued;
                        loop.Queued = 0;
                    }
                    demand = 1;
                    gate.Share();
                    gate.Grant(started);
                    if (loop.Pending == 0) loop.Done?.Set();
                }
                gate.Start(started);
            }

            /// <summary>Runs <paramref name="body"/> for each of <paramref name="items"/> items, on the lease's own thread
            /// and the workers the gate starts for it, each worker with a <paramref name="state"/> of its own; returns when
            /// all have run, or rethrows the first exception (a cancellation, or one a body threw) once every worker has
            /// stopped. A worker over the lease's share hands its thread back between items, so items should be short
            /// enough to give threads back promptly.</summary>
            public void For<TState>(int items, Func<TState> state, Action<int, TState> body, CancellationToken token)
            {
                if (items <= 0) return;
                if (Math.Min(wanted, items) <= 1)
                {
                    if (Count > 1) Settle();
                    var own = state();
                    for (var index = 0; index < items; index++)
                    {
                        token.ThrowIfCancellationRequested();
                        body(index, own);
                    }
                    return;
                }
                using var done = new ManualResetEventSlim(false);
                var step = new Step<TState>(this, items, state, body, token) { Done = done };
                Open(step, Math.Min(wanted, items));
                step.Work(owner: true);
                Close();
                done.Wait();
                step.Failure?.Throw();
            }

            /// <summary>A step on the owner's thread alone: threads the lease was given past it go back.</summary>
            private void Settle()
            {
                var started = new List<Loop>();
                lock (gate.sync)
                {
                    demand = 1;
                    gate.Free(this, held - 1);
                    gate.Share();
                    gate.Grant(started);
                }
                gate.Start(started);
            }

            public void For(int items, Action<int> body, CancellationToken token = default) => For<object?>(items, static () => null, (index, _) => body(index), token);

            public void Dispose()
            {
                var started = new List<Loop>();
                lock (gate.sync)
                {
                    if (disposed) return;
                    disposed = true;
                    gate.Free(this, held);
                    gate.leases.Remove(this);
                    gate.Share();
                    gate.Grant(started);
                }
                gate.Start(started);
            }
        }

        private sealed class Step<TState>(Lease lease, int items, Func<TState> state, Action<int, TState> body, CancellationToken token) : Loop
        {
            private int next, failed;
            public ExceptionDispatchInfo? Failure;

            public override void Execute()
            {
                if (lease.Begin(this)) Work(owner: false);
            }

            public void Work(bool owner)
            {
                var handedBack = false;
                try
                {
                    TState own = default!;
                    var made = false;
                    while (Volatile.Read(ref failed) == 0)
                    {
                        if (!owner && !lease.Keep())
                        {
                            handedBack = true;
                            return;
                        }
                        token.ThrowIfCancellationRequested();
                        var index = Interlocked.Increment(ref next) - 1;
                        if (index >= items) return;
                        if (!made)
                        {
                            own = state();
                            made = true;
                        }
                        body(index, own);
                    }
                }
                catch (Exception error)
                {
                    Interlocked.CompareExchange(ref Failure, ExceptionDispatchInfo.Capture(error), null);
                    Volatile.Write(ref failed, 1);
                    // The other workers take no more items: none would be used.
                    Volatile.Write(ref next, items);
                }
                finally
                {
                    if (!owner && !handedBack) lease.Exit();
                }
            }
        }
    }
}
