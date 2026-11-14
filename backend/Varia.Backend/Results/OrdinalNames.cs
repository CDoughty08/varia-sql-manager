using System.Collections.Frozen;
using System.Globalization;
using System.Text.RegularExpressions;

namespace Varia.Backend.Results;

/// <summary>
/// Column names compared case-insensitively for a diff's pairing, as OrdinalIgnoreCase does, but through one fixed table
/// (src/shared/ordinal-casing.ts, embedded) instead of the casing of the operating system's ICU, which differs by Unicode
/// version. The Compare picker and the fake backend read the same table, so all three pair the same columns on every
/// platform. DiffChecks.OrdinalCasing checks the table and, with VARIA_UPDATE_ORDINAL_CASING=1, rewrites it from the
/// runtime's casing.
/// </summary>
internal static partial class OrdinalNames
{
    private static readonly FrozenDictionary<int, int> Keys = Load();

    /// <summary>How many code points the table maps.</summary>
    public static int Count => Keys.Count;

    /// <summary>FNV-1a over the table's code points and keys in code point order: the generator writes it into the file, so
    /// a range lost or skipped (by an edit, or a line the parser does not read) shows.</summary>
    public static uint Checksum
    {
        get
        {
            var hash = 2166136261u;
            foreach (var (code, key) in Keys.OrderBy(item => item.Key)) foreach (var value in new[] { code, key }) { hash ^= (uint)value; hash *= 16777619u; }
            return hash;
        }
    }

    /// <summary>The code point a name's code point compares as.</summary>
    public static int Key(int code) => Keys.TryGetValue(code, out var key) ? key : code;

    /// <summary>The same length, and each code point (a valid surrogate pair is one; a lone surrogate is its own) equal or
    /// of the same key.</summary>
    public static bool Same(string a, string b)
    {
        if (a.Length != b.Length) return false;
        for (var at = 0; at < a.Length;)
        {
            var x = CodeAt(a, at, out var size);
            var y = CodeAt(b, at, out var other);
            if (size != other) return false;
            if (x != y && Key(x) != Key(y)) return false;
            at += size;
        }
        return true;
    }

    private static int CodeAt(string text, int at, out int size)
    {
        if (char.IsSurrogatePair(text, at)) { size = 2; return char.ConvertToUtf32(text[at], text[at + 1]); }
        size = 1;
        return text[at];
    }

    [GeneratedRegex(@"^  \[(\d+), (\d+), (-?\d+), ([12])\],?$")]
    private static partial Regex RangeLine();

    private static FrozenDictionary<int, int> Load()
    {
        using var stream = typeof(OrdinalNames).Assembly.GetManifestResourceStream("Varia.Backend.Results.ordinal-casing.ts")
            ?? throw new InvalidOperationException("The column-name casing table is missing.");
        using var reader = new StreamReader(stream);
        var keys = new Dictionary<int, int>();
        var inside = false;
        while (reader.ReadLine() is { } line)
        {
            if (line.StartsWith("// <generated", StringComparison.Ordinal)) { inside = true; continue; }
            if (line.StartsWith("// </generated>", StringComparison.Ordinal)) break;
            var match = inside ? RangeLine().Match(line) : Match.Empty;
            if (!match.Success) continue;
            int Number(int group) => int.Parse(match.Groups[group].Value, CultureInfo.InvariantCulture);
            int first = Number(1), last = Number(2), delta = Number(3), stride = Number(4);
            for (var code = first; code <= last; code += stride) keys[code] = code + delta;
        }
        return keys.ToFrozenDictionary();
    }
}
