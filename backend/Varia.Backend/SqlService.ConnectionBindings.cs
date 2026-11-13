namespace Varia.Backend;

internal sealed partial class SqlService
{
    private readonly object bindingGate = new();
    private readonly Dictionary<string, long> bindingRevisions = new(StringComparer.Ordinal);
    private readonly AsyncLocal<BindingCapture?> bindingCapture = new();
    internal const int MaxBindingChanges = 256;

    /// <summary>Only confirmed local binding changes enter this request's ordinary result. An exception/unknown action
    /// outcome has no acknowledgement; main keeps its admission fence. Captures contain no credentials or SQL text.</summary>
    internal async Task<ActionExecuteResult> CaptureBindingChangesAsync(Func<Task<ActionExecuteResult>> action)
    {
        var previous = bindingCapture.Value;
        var capture = new BindingCapture();
        bindingCapture.Value = capture;
        try
        {
            var result = await action();
            var (changes, complete) = capture.Seal();
            return result with { BindingChanges = changes, BindingChangesComplete = complete };
        }
        finally { capture.Close(); bindingCapture.Value = previous; }
    }

    private long BindingRevisionOf(string connectionId) { lock (bindingGate) return bindingRevisions.GetValueOrDefault(connectionId); }

    // Called under bindingGate before mutation; the revision is committed with the settings change below.
    private long NextBindingRevision(string connectionId)
    {
        var revision = bindingRevisions.GetValueOrDefault(connectionId);
        if (revision >= MaxSafeInteger)
        {
            bindingCapture.Value?.Incomplete();
            throw new RequestException("AUTH_IDENTITY", "This connection's settings could not be acknowledged. Disconnect, then connect again before reusing it.");
        }
        return revision + 1;
    }

    // Called under bindingGate immediately after the matching connection-string mutation.
    private void BindingChanged(ConnectionBindingChange change)
    {
        bindingRevisions[change.ConnectionId] = change.BindingRevision;
        bindingCapture.Value?.Record(change);
    }

    private sealed class BindingCapture
    {
        private readonly object gate = new();
        private readonly Dictionary<string, ConnectionBindingChange> changes = new(StringComparer.Ordinal);
        private bool complete = true, sealedCapture;

        internal void Incomplete() { lock (gate) complete = false; }
        internal void Close() { lock (gate) sealedCapture = true; }

        internal void Record(ConnectionBindingChange change)
        {
            lock (gate)
            {
                if (sealedCapture) return;
                if (changes.TryGetValue(change.ConnectionId, out var previous))
                {
                    changes[change.ConnectionId] = change with {
                        NewDatabase = change.NewDatabase ?? previous.NewDatabase,
                        PasswordChanged = change.PasswordChanged == true || previous.PasswordChanged == true ? true : null
                    };
                }
                else if (changes.Count < MaxBindingChanges) changes.Add(change.ConnectionId, change);
                else complete = false;
            }
        }

        internal (List<ConnectionBindingChange> Changes, bool Complete) Seal()
        {
            lock (gate)
            {
                sealedCapture = true;
                return ([.. changes.Values.OrderBy(change => change.ConnectionId, StringComparer.Ordinal)], complete);
            }
        }
    }
}
