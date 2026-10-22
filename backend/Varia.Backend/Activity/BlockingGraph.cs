namespace Varia.Backend.Activity;

/// <summary>One blocking wait: a session, the session it waits on (or a negative id: an orphaned DTC transaction, deferred
/// recovery, a latch owner), and the wait. <see cref="FromTask"/> waits come from sys.dm_os_waiting_tasks; the others are a
/// request's blocking_session_id, used only for a session no task wait names.</summary>
internal readonly record struct BlockingWait(int Waiter, int Blocker, string? WaitType, long WaitMs, string? Resource, bool FromTask = true);

/// <summary>A session in the blocking graph. <see cref="BlockedBy"/> is what it waits on longest (null for a lead
/// blocker); <see cref="Downstream"/> counts the sessions below it in its chain; <see cref="Cycle"/> marks a cycle, which is
/// cut at its lowest session id.</summary>
internal sealed record BlockingNode(int SessionId, int? BlockedBy, string? WaitType, long WaitMs, string? WaitResource, bool HeadBlocker, int Downstream, bool Cycle);

/// <summary>A Blocking pane row: a session at its depth in its chain (lead blockers at 0).</summary>
internal readonly record struct BlockingRow(BlockingNode Node, int Depth);

/// <summary>The blocking chains of one sample, built in memory (no SQL, no state between samples). Each session appears once,
/// under the session it has waited on longest, unlike SSMS, which lists a blocker once per session it blocks. A lead blocker
/// blocks someone and waits on no one, whether or not it has a request (an idle session holding a transaction is the classic
/// one).</summary>
internal sealed class BlockingGraph
{
    private BlockingGraph(Dictionary<int, BlockingNode> nodes, List<BlockingRow> rows, bool truncated)
    {
        Nodes = nodes;
        Rows = rows;
        Truncated = truncated;
    }

    /// <summary>Every session that blocks or waits, by session id.</summary>
    public IReadOnlyDictionary<int, BlockingNode> Nodes { get; }
    /// <summary>The chains as rows: lead blockers by sessions downstream, then their longest wait, each followed by the
    /// sessions it blocks in the same order.</summary>
    public IReadOnlyList<BlockingRow> Rows { get; }
    /// <summary>A chain was deeper than the depth cap, or the rows passed the row cap.</summary>
    public bool Truncated { get; }
    public int BlockedSessions => Nodes.Values.Count(node => node.BlockedBy is not null);

    public BlockingNode? Of(int sessionId) => Nodes.GetValueOrDefault(sessionId);

    public static BlockingGraph Build(IEnumerable<BlockingWait> waits, int maxDepth, int maxRows)
    {
        // A session's own parallel tasks waiting on each other, and "not blocked" (0), are not blocking.
        var valid = waits.Where(wait => wait.Waiter > 0 && wait.Blocker != 0 && wait.Blocker != wait.Waiter).ToList();
        var fromTasks = valid.Where(wait => wait.FromTask).Select(wait => wait.Waiter).ToHashSet();
        var best = new Dictionary<(int Waiter, int Blocker), BlockingWait>();
        foreach (var wait in valid)
        {
            if (!wait.FromTask && fromTasks.Contains(wait.Waiter)) continue;
            if (!best.TryGetValue((wait.Waiter, wait.Blocker), out var known) || wait.WaitMs > known.WaitMs) best[(wait.Waiter, wait.Blocker)] = wait;
        }

        // The wait each session hangs under: the longest on a session, else the longest on a negative id; ties by lowest id.
        var chosen = new Dictionary<int, BlockingWait>();
        foreach (var group in best.Values.GroupBy(wait => wait.Waiter))
        {
            var sessions = group.Where(wait => wait.Blocker > 0).ToList();
            var pool = sessions.Count > 0 ? sessions : [.. group];
            chosen[group.Key] = pool.OrderByDescending(wait => wait.WaitMs).ThenBy(wait => Math.Abs(wait.Blocker)).First();
        }
        var ids = new SortedSet<int>(chosen.Keys);
        foreach (var wait in chosen.Values) if (wait.Blocker > 0) ids.Add(wait.Blocker);
        var parent = ids.ToDictionary(id => id, id => chosen.TryGetValue(id, out var wait) && wait.Blocker > 0 ? wait.Blocker : (int?)null);

        // A cycle (a deadlock SQL Server has not resolved yet) is cut at its lowest session id; every member is marked.
        var cycle = new HashSet<int>();
        var state = new Dictionary<int, int>();
        foreach (var start in ids)
        {
            var path = new List<int>();
            var at = (int?)start;
            while (at is int id && !state.ContainsKey(id))
            {
                state[id] = 1;
                path.Add(id);
                at = parent[id];
            }
            if (at is int seen && state[seen] == 1)
            {
                var members = path.Skip(path.IndexOf(seen)).ToList();
                cycle.UnionWith(members);
                parent[members.Min()] = null;
            }
            foreach (var id in path) state[id] = 2;
        }

        var children = ids.ToDictionary(id => id, _ => new List<int>());
        foreach (var (id, up) in parent) if (up is int blocker) children[blocker].Add(id);
        var downstream = new Dictionary<int, int>();
        var longest = new Dictionary<int, long>();
        var roots = ids.Where(id => parent[id] is null).ToList();
        // Post-order without recursion: a chain can be thousands deep.
        foreach (var root in roots)
        {
            var stack = new Stack<(int Id, bool Done)>();
            stack.Push((root, false));
            while (stack.Count > 0)
            {
                var (id, done) = stack.Pop();
                if (!done)
                {
                    stack.Push((id, true));
                    foreach (var child in children[id]) stack.Push((child, false));
                    continue;
                }
                downstream[id] = children[id].Sum(child => downstream[child] + 1);
                longest[id] = Math.Max(chosen.TryGetValue(id, out var wait) ? wait.WaitMs : 0, children[id].Count == 0 ? 0 : children[id].Max(child => longest[child]));
            }
        }

        var nodes = ids.ToDictionary(id => id, id =>
        {
            var has = chosen.TryGetValue(id, out var wait);
            return new BlockingNode(id, has ? wait.Blocker : null, has ? wait.WaitType : null, has ? wait.WaitMs : 0, has ? wait.Resource : null,
                HeadBlocker: !has && children[id].Count > 0, downstream[id], cycle.Contains(id));
        });
        List<int> Ordered(IEnumerable<int> list) => [.. list.OrderByDescending(id => downstream[id]).ThenByDescending(id => longest[id]).ThenBy(id => id)];
        var rows = new List<BlockingRow>();
        var truncated = false;
        var pending = new Stack<(int Id, int Depth)>();
        foreach (var root in Enumerable.Reverse(Ordered(roots))) pending.Push((root, 0));
        while (pending.Count > 0)
        {
            var (id, depth) = pending.Pop();
            if (depth > maxDepth || rows.Count >= maxRows)
            {
                truncated = true;
                continue;
            }
            rows.Add(new(nodes[id], depth));
            foreach (var child in Enumerable.Reverse(Ordered(children[id]))) pending.Push((child, depth + 1));
        }
        return new(nodes, rows, truncated);
    }
}
