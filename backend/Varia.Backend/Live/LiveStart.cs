using System.Text.Json;

namespace Varia.Backend.Live;

/// <summary>Where an append table starts (src/shared/live/schema.ts, liveStartSchema), for a source whose args take it: at its
/// first row (beginning), at its last Value rows (tail; a note row says how many earlier rows are not shown), or at the rows
/// just before the id Value (before: older rows than a view already shows, ending there).</summary>
internal sealed record LiveStart(string Kind, long Value)
{
    public static readonly LiveStart Beginning = new("beginning", 0);

    /// <summary>Reads a start strictly, as main's schema does: "beginning", {"tail": 1..maxTail} or {"before": 1..2^53−1}.</summary>
    public static LiveStart Parse(JsonElement element, int maxTail)
    {
        static RequestException Invalid() => new("INVALID_PARAMS", "Invalid arguments for this source.");
        if (element.ValueKind == JsonValueKind.String) return element.GetString() == "beginning" ? Beginning : throw Invalid();
        if (element.ValueKind != JsonValueKind.Object) throw Invalid();
        var members = element.EnumerateObject().ToList();
        if (members is not [var member] || member.Value.ValueKind != JsonValueKind.Number || !member.Value.TryGetInt64(out var value)) throw Invalid();
        return member.Name switch
        {
            "tail" when value is >= 1 && value <= maxTail => new("tail", value),
            "before" when value is >= 1 and <= (1L << 53) - 1 => new("before", value),
            _ => throw Invalid()
        };
    }

    /// <summary>The note row's text for a start that left <paramref name="earlier"/> rows out.</summary>
    public static string Note(long earlier) => earlier == 1 ? "1 earlier row is not shown." : earlier.ToString("N0", System.Globalization.CultureInfo.InvariantCulture) + " earlier rows are not shown.";
}
