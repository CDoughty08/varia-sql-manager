namespace Varia.Backend.Protocol;

/// <summary>The only writer of stdout, on its own thread. Two lanes: control (HELLO, RESPONSE, EVENT, PONG, GOAWAY) is
/// always drained before bulk (DATA and stream RESPONSEs), so a large page never delays an answer or a PONG. Frames go
/// through a 64 KiB buffer that is flushed whenever both lanes are empty; larger frames pass straight through. A DATA
/// frame is queued as its header plus the stored page array, which is written as is, never copied.</summary>
internal sealed class Outbound
{
    private readonly record struct Outgoing(byte[] Head, byte[]? Body)
    {
        public long Length => Head.Length + (Body?.Length ?? 0);
    }

    public const int MaxDroppableFrames = 1000;
    public const long MaxDroppableBytes = 8 * 1024 * 1024;
    private readonly object gate = new();
    private readonly Queue<Outgoing> control = new();
    private readonly Queue<Outgoing> bulk = new();
    private readonly Stream output;
    private readonly Action onBroken;
    private readonly Thread thread;
    private readonly ManualResetEventSlim stopped = new();
    private long controlBytes;
    private bool completing;
    private long dropped;

    public Outbound(Stream output, Action onBroken)
    {
        this.output = new BufferedStream(output, 64 * 1024);
        this.onBroken = onBroken;
        thread = new Thread(Run) { Name = "varia-ipc-writer", IsBackground = true };
    }

    /// <summary>Droppable frames refused because the control lane was full.</summary>
    public long DroppedFrames => Interlocked.Read(ref dropped);

    public void Start() => thread.Start();

    /// <summary>Queues a control frame. A droppable frame (a query event) is refused once the lane holds more than
    /// 1,000 frames or 8 MiB, for example while main is blocked; RESPONSE, PONG and GOAWAY are never dropped, and the
    /// queue never makes the backend exit, because that would destroy every session.</summary>
    public bool Control(byte[] frame, bool droppable = false)
    {
        lock (gate)
        {
            if (completing) return false;
            if (droppable && (control.Count >= MaxDroppableFrames || controlBytes + frame.Length > MaxDroppableBytes))
            {
                dropped++;
                return false;
            }
            control.Enqueue(new Outgoing(frame, null));
            controlBytes += frame.Length;
            Monitor.Pulse(gate);
        }
        return true;
    }

    public void Bulk(byte[] frame) => Bulk(frame, null);

    /// <summary>Queues a frame given as its header and body; the body array is written as is.</summary>
    public void Bulk(byte[] head, byte[]? body)
    {
        lock (gate)
        {
            if (completing) return;
            bulk.Enqueue(new Outgoing(head, body));
            Monitor.Pulse(gate);
        }
    }

    /// <summary>Stops accepting frames and waits until those already queued are written (or the pipe broke).</summary>
    public bool Complete(TimeSpan timeout)
    {
        lock (gate)
        {
            completing = true;
            Monitor.Pulse(gate);
        }
        // The writer itself may report a broken pipe and end the process; it must not wait for itself.
        return Thread.CurrentThread == thread || stopped.Wait(timeout);
    }

    private void Run()
    {
        try
        {
            var dirty = false;
            while (true)
            {
                Outgoing frame;
                lock (gate)
                {
                    if (control.TryDequeue(out frame)) controlBytes -= frame.Length;
                    else if (!bulk.TryDequeue(out frame) && !dirty)
                    {
                        if (completing) return;
                        Monitor.Wait(gate);
                        continue;
                    }
                }
                if (frame.Head is null)
                {
                    output.Flush();
                    dirty = false;
                    continue;
                }
                output.Write(frame.Head);
                if (frame.Body is not null) output.Write(frame.Body);
                dirty = true;
            }
        }
        catch (Exception error) when (error is IOException or ObjectDisposedException)
        {
            // Nobody can read anything this process would still write. .NET's console stdout swallows broken-pipe errors,
            // so in the application main's exit is seen as stdin EOF instead; this covers other streams and failures.
            lock (gate) completing = true;
            stopped.Set();
            onBroken();
        }
        finally { stopped.Set(); }
    }
}
