namespace Varia.Backend;

internal enum MessageKind { Info, Error }

/// <summary>The Messages tab of one query, in order: PRINT and informational output, row counts, and SQL errors, cancellation
/// and timeout as error entries.</summary>
/// <param name="stored">Told about each entry as it is stored (for query events).</param>
internal sealed class QueryMessages(Action<MessageEntry>? stored = null)
{
    public const string Info = "info";
    public const string Error = "error";
    private const int MaxMessages = 1000;
    private const int MaxCharacters = 1_000_000;
    private readonly List<MessageEntry> messages = [];
    private int characters;
    public bool Truncated { get; private set; }

    public void Add(string text, MessageKind kind = MessageKind.Info)
    {
        lock (messages)
        {
            if (messages.Count >= MaxMessages || characters >= MaxCharacters) { Truncated = true; return; }
            var available = MaxCharacters - characters;
            if (text.Length > available) { text = text[..available]; Truncated = true; }
            var entry = new MessageEntry(text, kind == MessageKind.Error ? Error : Info);
            messages.Add(entry);
            characters += text.Length;
            stored?.Invoke(entry);
        }
    }

    public List<MessageEntry> Snapshot()
    {
        lock (messages)
        {
            var result = new List<MessageEntry>(messages);
            if (Truncated) result.Add(new("Messages were truncated by the display limit; later statistics or PRINT output may be omitted.", Info));
            return result;
        }
    }
}
