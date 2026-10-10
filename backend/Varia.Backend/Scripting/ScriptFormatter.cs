namespace Varia.Backend.Scripting;

/// <summary>How batches become one script, for SMO's batches and the templates alike (spec B9). Line breaks are
/// Environment.NewLine, as SMO writes them, and a batch's own text is never changed: a module's definition must come
/// back byte for byte.</summary>
internal static class ScriptFormatter
{
    public static string NewLine => Environment.NewLine;

    /// <summary>[name] with ] doubled, as QUOTENAME does.</summary>
    public static string Quote(string name) => "[" + name.Replace("]", "]]") + "]";

    /// <summary>The batch that sets the database context, which templates write themselves (SMO writes its own).</summary>
    public static string Use(string database) => "USE " + Quote(database);

    /// <summary>A batch as it appears in the script: its text, a line break unless it ends with one, then GO and a blank
    /// line when statements are delimited, otherwise just the blank line.</summary>
    public static string Frame(string batch, bool delimit)
    {
        var text = batch.EndsWith('\n') ? batch : batch + NewLine;
        return delimit ? text + "GO" + NewLine + NewLine : text + NewLine;
    }
}
