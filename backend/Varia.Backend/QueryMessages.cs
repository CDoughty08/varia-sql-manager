namespace Varia.Backend;

/// <summary>Info is Varia's own lines (row counts and notes); Server is SQL Server's informational messages (PRINT, RAISERROR
/// with severity 10 or less, SET STATISTICS output), which open the Messages strip under the results; Error is shown in red.</summary>
internal enum MessageKind { Info, Server, Error }

/// <summary>The Messages tab of one query, in order: PRINT and informational output, row counts, and SQL errors, cancellation
/// and timeout as error entries.</summary>
/// <param name="stored">Told about each entry as it is stored (for query events).</param>
internal sealed class QueryMessages(Action<MessageEntry>? stored = null)
{
    public const string Info = "info";
    public const string Server = "server";
    public const string Error = "error";
    public const int MaxMessages = 1000;
    /// <summary>Error entries kept after the caps are reached (limits.messages.lateErrors in src/shared/ipc/wire/protocol.ts),
    /// each cut at the error text cap: the error that stopped a script, or its cancellation or timeout, must still be in
    /// Messages after a flood of PRINT output or row counts.</summary>
    public const int MaxLateErrors = 20;
    private const int MaxCharacters = 1_000_000;
    private const int MaxLateCharacters = 16_384;
    private readonly List<MessageEntry> messages = [];
    private int characters, lateErrors;
    /// <summary>Where the truncation note goes: after the last entry stored within the caps.</summary>
    private int truncatedAt;
    public bool Truncated { get; private set; }

    public void Add(string text, MessageKind kind = MessageKind.Info)
    {
        lock (messages)
        {
            if (messages.Count - lateErrors >= MaxMessages || characters >= MaxCharacters)
            {
                MarkTruncated();
                if (kind != MessageKind.Error || lateErrors >= MaxLateErrors) return;
                lateErrors++;
                Store(text.Length > MaxLateCharacters ? text[..MaxLateCharacters] : text, kind);
                return;
            }
            var cut = text.Length > MaxCharacters - characters;
            if (cut) text = text[..(MaxCharacters - characters)];
            characters += text.Length;
            Store(text, kind);
            if (cut) MarkTruncated();
        }
    }

    public List<MessageEntry> Snapshot()
    {
        lock (messages)
        {
            var result = new List<MessageEntry>(messages);
            if (Truncated) result.Insert(truncatedAt, new("Messages were truncated by the display limit; later statistics or PRINT output may be omitted.", Info));
            return result;
        }
    }

    private void MarkTruncated()
    {
        if (Truncated) return;
        Truncated = true;
        truncatedAt = messages.Count;
    }

    private void Store(string text, MessageKind kind)
    {
        var entry = new MessageEntry(text, kind switch { MessageKind.Error => Error, MessageKind.Server => Server, _ => Info });
        messages.Add(entry);
        stored?.Invoke(entry);
    }
}
