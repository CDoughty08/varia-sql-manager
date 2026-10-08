namespace Varia.Backend;

internal sealed class QueryMessages
{
    private const int MaxMessages = 1000;
    private const int MaxCharacters = 1_000_000;
    private readonly List<string> messages = [];
    private int characters;
    public bool Truncated { get; private set; }

    public void Add(string message)
    {
        lock (messages)
        {
            if (messages.Count >= MaxMessages || characters >= MaxCharacters) { Truncated = true; return; }
            var available = MaxCharacters - characters;
            if (message.Length > available) { message = message[..available]; Truncated = true; }
            messages.Add(message);
            characters += message.Length;
        }
    }

    public List<string> Snapshot()
    {
        lock (messages)
        {
            var result = new List<string>(messages);
            if (Truncated) result.Add("Messages were truncated by the display limit; later statistics or PRINT output may be omitted.");
            return result;
        }
    }
}
