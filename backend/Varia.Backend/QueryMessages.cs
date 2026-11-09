namespace Varia.Backend;

/// <summary>Info is Varia's own lines (row counts and notes); Print is what the script printed (PRINT, RAISERROR with severity 10
/// or less), which opens the Messages strip under the results; Server is SQL Server's other informational messages (warnings
/// such as 8153, SET STATISTICS output, DBCC), shown without opening it; Error is shown in red.</summary>
internal enum MessageKind { Info, Server, Print, Error }

/// <summary>The Messages tab of one query, in order: PRINT and informational output, row counts, and SQL errors, cancellation
/// and timeout as error entries.</summary>
/// <param name="stored">Told about each entry as it is stored (for query events).</param>
internal sealed class QueryMessages(Action<MessageEntry>? stored = null)
{
    public const string Info = "info";
    public const string Server = "server";
    public const string Print = "print";
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

    /// <summary>A script location only exists for a line in a submitted batch, not inside a stored procedure.</summary>
    public static int? ScriptLine(int startLine, int batchStartLine, int errorLine, string? procedure = null)
    {
        if (!string.IsNullOrEmpty(procedure) || startLine < 1 || batchStartLine < 1 || errorLine < 1) return null;
        var line = (long)startLine + batchStartLine + errorLine - 2;
        return line is > 0 and <= int.MaxValue ? (int)line : null;
    }

    public void Add(string text, MessageKind kind = MessageKind.Info, int? line = null)
    {
        lock (messages)
        {
            if (messages.Count - lateErrors >= MaxMessages || characters >= MaxCharacters)
            {
                MarkTruncated();
                if (kind != MessageKind.Error || lateErrors >= MaxLateErrors) return;
                lateErrors++;
                Store(text.Length > MaxLateCharacters ? text[..MaxLateCharacters] : text, kind, line);
                return;
            }
            var cut = text.Length > MaxCharacters - characters;
            if (cut) text = text[..(MaxCharacters - characters)];
            characters += text.Length;
            Store(text, kind, line);
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

    private void Store(string text, MessageKind kind, int? line)
    {
        var entry = new MessageEntry(text, kind switch { MessageKind.Error => Error, MessageKind.Server => Server, MessageKind.Print => Print, _ => Info },
            kind == MessageKind.Error && line is > 0 ? line : null);
        messages.Add(entry);
        stored?.Invoke(entry);
    }
}
