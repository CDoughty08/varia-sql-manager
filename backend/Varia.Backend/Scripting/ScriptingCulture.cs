using System.Globalization;
using System.Text.RegularExpressions;

namespace Varia.Backend.Scripting;

/// <summary>The culture SMO formats a header's "Script Date:" in, as SSMS does in the user's locale. Main passes the OS
/// locale as VARIA_LOCALE (macOS GUI launches have no LANG); only scripting threads use it, and anything invalid or
/// unknown to ICU falls back to the invariant culture.</summary>
internal static partial class ScriptingCulture
{
    private static readonly Lazy<CultureInfo> FromEnvironment = new(() => Parse(Environment.GetEnvironmentVariable("VARIA_LOCALE")));

    [GeneratedRegex(@"^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$")]
    private static partial Regex Tag();

    /// <summary>Checks set it to compare scripts across cultures; null restores VARIA_LOCALE's.</summary>
    internal static CultureInfo? Override { get; set; }

    public static CultureInfo Current => Override ?? FromEnvironment.Value;

    private sealed record Derived(CultureInfo Source, CultureInfo Result);
    private static Derived? formatting;

    /// <summary>The culture scripting threads run in: <see cref="Current"/>'s dates, the invariant culture's numbers. SMO
    /// formats IDENTITY seeds and sequence bounds with it, and a minus sign such as sv-SE's U+2212 or he-IL's U+200E
    /// prefix would make the script fail to run (or SMO refuse a sequence).</summary>
    public static CultureInfo Formatting
    {
        get
        {
            var current = Current;
            if (formatting is { } cached && ReferenceEquals(cached.Source, current)) return cached.Result;
            var culture = (CultureInfo)current.Clone();
            culture.NumberFormat = (NumberFormatInfo)CultureInfo.InvariantCulture.NumberFormat.Clone();
            var result = CultureInfo.ReadOnly(culture);
            formatting = new Derived(current, result);
            return result;
        }
    }

    public static CultureInfo Parse(string? tag)
    {
        if (tag is null || tag.Length > 35 || !Tag().IsMatch(tag)) return CultureInfo.InvariantCulture;
        try { return CultureInfo.GetCultureInfo(tag, predefinedOnly: true); }
        catch (CultureNotFoundException) { return CultureInfo.InvariantCulture; }
    }
}
