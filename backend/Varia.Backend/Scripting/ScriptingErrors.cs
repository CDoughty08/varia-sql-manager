using System.Globalization;
using System.Text;
using Microsoft.Data.SqlClient;
using Microsoft.SqlServer.Management.Smo;

namespace Varia.Backend.Scripting;

/// <summary>SMO wrote more than the output cap; the sink stops it.</summary>
internal sealed class ScriptTooLargeException() : Exception("The script is too large.");

/// <summary>What a message names: the object as Object Explorer shows it, its kind's title and the verb.</summary>
internal sealed record ScriptSubject(string Display, string Title, string Verb, string? Database);

/// <summary>Scripting failures as values (spec B10, C9). Messages name only the object, the database and SQL Server's or
/// SMO's own text; never SQL text, connection strings or stack traces.</summary>
internal static class ScriptingErrors
{
    public const int MaxMessage = 2048, MaxDisplay = 400, MaxServerText = 300, MaxDetail = 1024, MaxState = 200;
    private static readonly int[] Blocked = [1222, 1205];
    private static readonly int[] Permission = [229, 230, 262, 297, 300, 15151, 15247];
    private static readonly int[] Unavailable = [916, 4060, 922, 924, 926, 927, 942, 945, 952, 976, 978];
    private static readonly int[] Lost = [-1, 2, 53, 64, 121, 233, 10053, 10054, 10060];

    /// <summary>A name as the renderer's displayText() shows it: controls, separators, bidi marks, the BOM and unpaired
    /// surrogates become visible markers such as ⟨U+202E⟩, at most 400 characters.</summary>
    public static string Display(string text) => Clip(Visible(text), MaxDisplay);

    /// <summary>Server or SMO text inside a message: line breaks and tabs become spaces, other hidden characters markers.</summary>
    public static string Detail(string text, int max) => Clip(Visible(string.Join(' ', text.Split(['\r', '\n', '\t'], StringSplitOptions.RemoveEmptyEntries)).Trim()), max);

    private static string Visible(string text)
    {
        var builder = new StringBuilder(text.Length);
        for (var i = 0; i < text.Length; i++)
        {
            var c = text[i];
            if (char.IsHighSurrogate(c) && i + 1 < text.Length && char.IsLowSurrogate(text[i + 1])) { builder.Append(c).Append(text[++i]); continue; }
            if (c <= '\u001f' || c is >= '\u007f' and <= '\u009f' || c is '\u2028' or '\u2029' || c is >= '\u202a' and <= '\u202e' || c is >= '\u2066' and <= '\u2069'
                || c == '\ufeff' || char.IsSurrogate(c))
                builder.Append("⟨U+").Append(((int)c).ToString("X4", CultureInfo.InvariantCulture)).Append('⟩');
            else builder.Append(c);
        }
        return builder.ToString();
    }

    public static string Clip(string text, int max) => text.Length <= max ? text : text[..(max - 1)] + "…";

    /// <summary>The index of the first unpaired UTF-16 surrogate, or −1.</summary>
    public static int UnpairedSurrogate(string text)
    {
        for (var i = 0; i < text.Length; i++)
        {
            if (char.IsHighSurrogate(text[i]) && i + 1 < text.Length && char.IsLowSurrogate(text[i + 1])) { i++; continue; }
            if (char.IsSurrogate(text[i])) return i;
        }
        return -1;
    }

    public static string VersionName(SqlServerVersion version) => version switch
    {
        SqlServerVersion.Version130 => "SQL Server 2016",
        SqlServerVersion.Version140 => "SQL Server 2017",
        SqlServerVersion.Version150 => "SQL Server 2019",
        SqlServerVersion.Version160 => "SQL Server 2022",
        SqlServerVersion.Version170 => "SQL Server 2025",
        _ => "SQL Server version " + SmoOptionsMapper.Known.First(item => item.Value == version).Number.ToString(CultureInfo.InvariantCulture)
    };

    /// <param name="detail">NOT_SUPPORTED from SMO: the target version and SMO's text; NO_DEFINITION: "server" for a
    /// server or database trigger whose hidden definition may be encrypted; TOO_LARGE: "definition" for the module
    /// pre-check; DATABASE_UNAVAILABLE: the state or server text; PERMISSION_DENIED, SMO_ERROR and SQL_ERROR: the
    /// server's or SMO's text, or why Varia refused the script.</param>
    public static ScriptError Create(ScriptingCatalog catalog, string code, ScriptSubject subject, string? detail = null, int number = 0)
    {
        var o = subject.Display;
        var message = code switch
        {
            "NOT_FOUND" => o + " no longer exists, or you do not have permission to see it. Refresh Object Explorer and try again.",
            "NOT_SUPPORTED" when detail is not null => o + " cannot be scripted for " + Detail(detail, MaxServerText + 40),
            "NOT_SUPPORTED" => subject.Verb + " scripts are not available for " + subject.Title + " " + o + ". Refresh Object Explorer and try again.",
            "ENCRYPTED" => o + " is encrypted (WITH ENCRYPTION), so its definition cannot be scripted. DROP and EXECUTE scripts still work.",
            "NO_DEFINITION" when detail == "server" => "The definition of " + o + " is encrypted, or you do not have permission to view it.",
            "NO_DEFINITION" => "You do not have permission to view the definition of " + o + ". VIEW DEFINITION on it is required.",
            "PERMISSION_DENIED" => "You do not have permission to script " + o + ": " + Detail(detail ?? "", MaxServerText),
            "DATABASE_UNAVAILABLE" => "Database " + Display(subject.Database ?? "") + " is not available (" + Detail(detail ?? "", MaxState) + "), so " + o + " cannot be scripted.",
            "TOO_LARGE" when detail == "definition" => "The definition of " + o + " is larger than 8 MB, which Varia cannot open.",
            "TOO_LARGE" => "The script for " + o + " is longer than 4,000,000 characters, which Varia cannot open. Turn off Generate script for dependent objects and Script triggers in Tools › Options › Scripting and try again.",
            "EMPTY" => "SQL Server Management Objects produced no " + subject.Verb + " script for " + o + ".",
            "BLOCKED" => "Another session holds a lock on " + o + "'s metadata (for example an uncommitted ALTER). Scripting waited 10 seconds; retry after it commits.",
            "TIMEOUT" => "Scripting " + o + " took longer than 55 seconds and was stopped.",
            "CONNECTION_LOST" => "The connection to the server was lost while scripting " + o + ".",
            "UNREPRESENTABLE" => o + " could not be scripted exactly: a name contains an unpaired UTF-16 surrogate, which cannot be saved or copied without changing it.",
            "SMO_ERROR" => "Could not script " + o + ": " + Detail(detail ?? "", MaxDetail),
            "SQL_ERROR" => "Could not script " + o + ": Msg " + number.ToString(CultureInfo.InvariantCulture) + ": " + Detail(detail ?? "", MaxDetail),
            _ => throw new InvalidOperationException("Unknown scripting error " + code)
        };
        return new(code, Clip(message, MaxMessage), catalog.Retryable(code));
    }

    /// <summary>A trigger or dependent object the target's script would carry is encrypted or over the definition limit:
    /// the message names that object and the option that brought it in, not the target.</summary>
    public static ScriptError Dependent(ScriptingCatalog catalog, DependentDefinitionException error, ScriptSubject subject)
    {
        var o = error.Parent is { } parent ? Display(error.Name) + " of " + Display(error.Schema + "." + parent) : Display(error.Schema + "." + error.Name);
        var message = error.Code == "ENCRYPTED"
            ? (error.Parent is null ? "" : "Trigger ") + o + " is encrypted (WITH ENCRYPTION), so " + subject.Display + " cannot be scripted with " + error.Option
                + " on. Turn it off in Tools › Options › Scripting and try again."
            : "The definition of " + (error.Parent is null ? "" : "trigger ") + o + " is larger than 8 MB, which Varia cannot open. Turn off " + error.Option
                + " in Tools › Options › Scripting and try again.";
        return new(error.Code, Clip(message, MaxMessage), catalog.Retryable(error.Code));
    }

    /// <summary>Maps an exception from the preflight or SMO to an error value (spec C9). Cancellation is the caller's to
    /// decide; anything unrecognised is null, so the request fails as a backend error.</summary>
    /// <param name="encrypted">The preflight found the module encrypted (PropertyCannotBeRetrieved then means ENCRYPTED).</param>
    /// <param name="target">The version the script targets, for SMO's version and feature refusals.</param>
    /// <param name="serverTrigger">A server or database trigger, whose missing definition has its own message.</param>
    public static ScriptError? Classify(ScriptingCatalog catalog, Exception error, ScriptSubject subject, bool encrypted = false, SqlServerVersion? target = null,
        bool serverTrigger = false, bool connectionBroken = false)
    {
        var chain = Chain(error).ToList();
        if (chain.OfType<DependentDefinitionException>().FirstOrDefault() is { } dependent) return Dependent(catalog, dependent, subject);
        if (chain.OfType<ScriptRefusedException>().FirstOrDefault() is { } refused) return Create(catalog, "SMO_ERROR", subject, refused.Reason);
        if (chain.OfType<ScriptTooLargeException>().Any()) return Create(catalog, "TOO_LARGE", subject);
        if (chain.OfType<EmptyScriptException>().Any()) return Create(catalog, "EMPTY", subject);
        if (chain.OfType<SmoObjectMissingException>().Any()) return Create(catalog, "NOT_FOUND", subject);
        if (chain.OfType<SqlException>().FirstOrDefault() is { } sql)
        {
            var first = sql.Errors.Cast<SqlError>().FirstOrDefault(item => item.Class > 10) ?? (sql.Errors.Count > 0 ? sql.Errors[0] : null);
            var number = first?.Number ?? sql.Number;
            var text = first?.Message ?? sql.Message;
            var code = SqlCode(number, first?.Class ?? sql.Class);
            if (code != "SQL_ERROR" || !chain.Any(IsSmoRefusal)) return Create(catalog, code, subject, text, number);
        }
        if (chain.OfType<MissingObjectException>().Any()) return Create(catalog, "NOT_FOUND", subject);
        if (chain.FirstOrDefault(IsSmoRefusal) is { } refusal)
            return Create(catalog, "NOT_SUPPORTED", subject, (target is { } version ? VersionName(version) : "this server") + ": " + Clip(refusal.Message, MaxServerText));
        if (chain.OfType<PropertyCannotBeRetrievedException>().Any())
            return Create(catalog, encrypted ? "ENCRYPTED" : "NO_DEFINITION", subject, serverTrigger ? "server" : null);
        if (connectionBroken) return Create(catalog, "CONNECTION_LOST", subject);
        if (chain.Any(item => item.GetType().Namespace?.StartsWith("Microsoft.SqlServer.Management", StringComparison.Ordinal) == true))
            return Create(catalog, "SMO_ERROR", subject, string.Join(" ", chain.Select(item => item.Message.Trim()).Where(text => text.Length > 0).Distinct()));
        return null;
    }

    /// <summary>The code of a SQL Server error by its number and severity (spec C9).</summary>
    public static string SqlCode(int number, byte severity) => number switch
    {
        _ when Blocked.Contains(number) => "BLOCKED",
        -2 => "TIMEOUT",
        _ when Permission.Contains(number) => "PERMISSION_DENIED",
        _ when Unavailable.Contains(number) => "DATABASE_UNAVAILABLE",
        // The database does not exist (any more), as Object Explorer reports it.
        911 => "NOT_FOUND",
        _ when severity >= 20 || Lost.Contains(number) => "CONNECTION_LOST",
        _ => "SQL_ERROR"
    };

    private static bool IsSmoRefusal(Exception error) =>
        error is UnsupportedVersionException or UnsupportedEngineEditionException or UnsupportedEngineTypeException or UnsupportedFeatureException
            or InvalidVersionSmoOperationException;

    private static IEnumerable<Exception> Chain(Exception error)
    {
        var pending = new Stack<Exception>([error]);
        var seen = 0;
        while (pending.Count > 0 && seen++ < 32)
        {
            var current = pending.Pop();
            yield return current;
            if (current is AggregateException aggregate) foreach (var inner in aggregate.InnerExceptions.Reverse()) pending.Push(inner);
            else if (current.InnerException is { } inner) pending.Push(inner);
        }
    }
}
