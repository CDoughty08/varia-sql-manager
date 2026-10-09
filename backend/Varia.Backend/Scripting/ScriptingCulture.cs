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

    public static CultureInfo Parse(string? tag)
    {
        if (tag is null || tag.Length > 35 || !Tag().IsMatch(tag)) return CultureInfo.InvariantCulture;
        try { return CultureInfo.GetCultureInfo(tag, predefinedOnly: true); }
        catch (CultureNotFoundException) { return CultureInfo.InvariantCulture; }
    }
}
