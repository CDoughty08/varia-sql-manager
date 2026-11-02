using System.Data;
using System.Globalization;
using System.Text.RegularExpressions;
using Microsoft.Data.SqlClient;
using Varia.Backend.Explorer;
using Varia.Backend.Scripting;

namespace Varia.Backend.Actions;

/// <summary>A path on the server (src/shared/actions/files.ts' serverPathProblem): 1–260 UTF-16 units, well formed, no control
/// characters or * ? " &lt; &gt; |, and absolute (a drive, a UNC share, or a Linux path). The separator is the server's.</summary>
internal static partial class ServerPath
{
    [GeneratedRegex(@"^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+|/)")]
    private static partial Regex Absolute();
    [GeneratedRegex(@"^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+)")]
    private static partial Regex WindowsAbsolute();

    public static bool Valid(string? path, long max)
    {
        if (string.IsNullOrEmpty(path) || path.Length > max || !Absolute().IsMatch(path)) return false;
        for (var i = 0; i < path.Length; i++)
        {
            var c = path[i];
            if (c < 0x20 || c is '*' or '?' or '"' or '<' or '>' or '|') return false;
            if (char.IsHighSurrogate(c) && (i + 1 == path.Length || !char.IsLowSurrogate(path[++i]))) return false;
            if (char.IsLowSurrogate(c)) return false;
        }
        return true;
    }

    /// <summary>The folder to list as the server writes it, ending with its separator (on Windows, forward slashes become
    /// backslashes), or null when the path is not a full path on a server of this platform.</summary>
    public static string? Folder(string path, bool linux)
    {
        if (linux) return path.StartsWith('/') ? path.EndsWith('/') ? path : path + "/" : null;
        var text = path.Replace('/', '\\');
        if (!WindowsAbsolute().IsMatch(text)) return null;
        return text.EndsWith('\\') ? text : text + "\\";
    }

    public static bool Same(string a, string b, bool linux) => string.Equals(a, b, linux ? StringComparison.Ordinal : StringComparison.OrdinalIgnoreCase);

    /// <summary>A full path as the file it names, for telling whether two spellings are one file (src/shared/actions/files.ts
    /// serverPathKey, the same tests/fixtures/server-paths.json): empty and '.' segments dropped and '..' resolved; on Windows also
    /// forward slashes as backslashes, each segment's trailing dots and spaces dropped (as Win32 drops them), and upper case. Null
    /// when it is not a full path there, or on Windows names a stream (a colon past the drive). Short (8.3) names and other shares
    /// of the same disk are not resolved: the restore's preflight asks SQL Server whether such a file exists.</summary>
    public static string? Key(string path, bool linux)
    {
        if (linux) return path.StartsWith('/') ? "/" + string.Join('/', Segments(path.Split('/'), linux: true)) : null;
        var text = path.Replace('/', '\\');
        string root;
        string[] rest;
        if (text.Length >= 3 && char.IsAsciiLetter(text[0]) && text[1] == ':' && text[2] == '\\') (root, rest) = (text[..3], text[3..].Split('\\'));
        else if (text.StartsWith(@"\\", StringComparison.Ordinal) && text[2..].Split('\\') is [{ Length: > 0 } host, { Length: > 0 } share, .. var more])
            (root, rest) = (@"\\" + host + "\\" + share + "\\", more);
        else return null;
        var segments = Segments(rest, linux: false);
        if (root.IndexOf(':', 2) >= 0 || segments.Any(segment => segment.Contains(':', StringComparison.Ordinal))) return null;
        return (root + string.Join('\\', segments)).ToUpperInvariant();
    }

    private static List<string> Segments(IEnumerable<string> parts, bool linux)
    {
        var segments = new List<string>();
        foreach (var part in parts)
        {
            if (part == "..") { if (segments.Count > 0) segments.RemoveAt(segments.Count - 1); continue; }
            var segment = linux ? part : part.TrimEnd('.', ' ');
            if (segment.Length > 0 && segment != ".") segments.Add(segment);
        }
        return segments;
    }
}

/// <summary>The server file picker's listing (actions.describe 'serverFiles'), on the object actions' connection under the read
/// gates and budget. Constant SQL with the path, take and type filter as parameters: from SQL Server 2017, when the server has
/// them, sys.dm_os_enumerate_filesystem at level 0 (which does not walk below it), sys.dm_os_file_exists and
/// sys.dm_os_enumerate_fixed_drives, as SMO's own enumerators use; before, xp_dirtree, xp_fileexist and xp_fixeddrives, which
/// answer only members of sysadmin (xp_dirtree with no rows rather than an error). Nothing here logs a path, name or count.</summary>
internal static partial class ServerFiles
{
    /// <summary>The default folders, whether the login is in sysadmin, and how many of the three file DMVs the server has.</summary>
    public const string Facts = "SELECT CONVERT(nvarchar(260), SERVERPROPERTY('InstanceDefaultDataPath')) AS data_path, CONVERT(nvarchar(260), SERVERPROPERTY('InstanceDefaultLogPath')) AS log_path, "
        + "CONVERT(nvarchar(260), SERVERPROPERTY('InstanceDefaultBackupPath')) AS backup_path, CONVERT(bit, ISNULL(IS_SRVROLEMEMBER(N'sysadmin'), 0)) AS sysadmin, "
        + "(SELECT COUNT(*) FROM sys.system_objects AS o WHERE o.name IN (N'dm_os_enumerate_filesystem', N'dm_os_file_exists', N'dm_os_enumerate_fixed_drives')) AS file_views;";

    public const string Drives = "SELECT TOP (@take) d.fixed_drive_path AS drive, d.free_space_in_bytes / 1048576 AS free_mb FROM sys.dm_os_enumerate_fixed_drives AS d ORDER BY d.fixed_drive_path;";

    public const string LegacyDrives = "DECLARE @d TABLE (drive nchar(1), free_mb int);\nINSERT @d EXEC master.sys.xp_fixeddrives;\n"
        + "SELECT TOP (@take) d.drive AS drive, CONVERT(bigint, d.free_mb) AS free_mb FROM @d AS d ORDER BY d.drive;";

    public const string Exists = "SELECT x.file_exists AS file_exists, x.file_is_a_directory AS is_directory FROM sys.dm_os_file_exists(@path) AS x;";

    public const string LegacyExists = "DECLARE @e TABLE (file_exists int, is_directory int, parent_exists int);\nINSERT @e EXEC master.sys.xp_fileexist @path;\n"
        + "SELECT e.file_exists AS file_exists, e.is_directory AS is_directory FROM @e AS e;";

    /// <summary>Folders always; files with @files, every one with @all, else those ending with @e1 or @e2 (lower case, any case on the server).</summary>
    private static string Filter(string name, string directory) => "(" + directory + " = 1 OR @files = 1 AND (@all = 1 OR LOWER(RIGHT(" + name + ", LEN(@e1))) = @e1 OR LOWER(RIGHT(" + name + ", LEN(@e2))) = @e2))";

    public static readonly string List = "SELECT TOP (@take) f.file_or_directory_name AS name, f.is_directory AS is_directory, f.size_in_bytes AS size_bytes, f.last_write_time AS modified "
        + "FROM sys.dm_os_enumerate_filesystem(@path, N'*') AS f WHERE f.[level] = 0 AND " + Filter("f.file_or_directory_name", "f.is_directory") + " "
        + "ORDER BY f.is_directory DESC, f.file_or_directory_name;";

    public static readonly string LegacyList = "DECLARE @t TABLE (name nvarchar(260), depth int, is_file bit);\nINSERT @t EXEC master.sys.xp_dirtree @path, 1, 1;\n"
        + "SELECT TOP (@take) t.name AS name, CONVERT(bit, 1 - t.is_file) AS is_directory FROM @t AS t WHERE t.depth = 1 AND " + Filter("t.name", "CONVERT(bit, 1 - t.is_file)") + " "
        + "ORDER BY t.is_file, t.name;";

    private sealed record ServerFacts(string? Data, string? Log, string? Backup, bool Sysadmin, bool Views);

    /// <summary>Lists the roots or one folder, or (Exists) checks one path. <paramref name="legacy"/> (the live checks only, through InternalsVisibleTo) uses the
    /// SQL Server 2016 statements on a newer server. Returns the listing or an error value.</summary>
    public static async Task<(ServerFilesDto? Listing, ActionError? Error)> ListAsync(SqlConnection connection, ActionsCatalog catalog, ServerFilesArgsDto files, bool linux, CancellationToken token,
        bool legacy = false)
    {
        var separator = linux ? "/" : "\\";
        var take = (int)catalog.Limit("browseEntries");
        var facts = await FactsAsync(connection, token);
        var modern = !legacy && facts.Views;
        if (files.Path is null) return (new(separator, null, await RootsAsync(connection, facts, modern, linux, take, token), [], false), null);

        var max = catalog.Limit("serverPath");
        var display = ScriptingErrors.Display(files.Path);
        var folder = ServerPath.Folder(files.Path, linux);
        if (folder is null) return (null, ActionErrors.Create(catalog, "PATH_NOT_FOUND", display + " is not a full path on this server" + (linux ? " (SQL Server runs on Linux, so paths start with /)." : ".")));
        // Without its trailing separator, so a file given as a folder is found as a file (C:\ and / keep theirs). At most as long as
        // the path asked, which Validate held to the limit.
        var probe = folder.Length > 1 && !(folder.Length == 3 && folder[1] == ':') ? folder[..^1] : folder;
        if (files.Exists == true)
        {
            // One path a listing may not show (past its limit, or outside the type filter): its own entry, or none. SQL Server
            // 2016's xp_fileexist answers only sysadmin, so for others the answer is unknown, which legacyEmpty says.
            if (!modern && !facts.Sysadmin) return (new(separator, probe, [], [], false, "legacyEmpty"), null);
            var (found, isDirectory) = await ExistsAsync(connection, modern ? Exists : LegacyExists, probe, token);
            var name = probe[(probe.LastIndexOf(separator, StringComparison.Ordinal) + 1)..];
            return (new(separator, probe, [], found || isDirectory ? [new(name.Length > 0 ? name : probe, isDirectory)] : [], false), null);
        }
        if (folder.Length > max) return (null, ActionErrors.Create(catalog, "PATH_NOT_FOUND", "A path is at most " + max + " characters."));
        // SQL Server 2016's xp_fileexist answers only sysadmin; for others the listing alone decides, and an empty one says why.
        if (modern || facts.Sysadmin)
        {
            var (exists, directory) = await ExistsAsync(connection, modern ? Exists : LegacyExists, probe, token);
            if (!directory)
                return (null, ActionErrors.Create(catalog, "PATH_NOT_FOUND", exists
                    ? display + " is a file, not a folder."
                    : "The folder " + ScriptingErrors.Display(folder) + " does not exist, or SQL Server's service account cannot see it."));
        }
        var extensions = catalog.ServerFilePurposes[files.Purpose];
        var entries = new List<ServerFileEntryDto>();
        await using (var command = connection.CreateCommand())
        {
            command.CommandText = modern ? List : LegacyList;
            command.CommandTimeout = 0;
            Add(command, "@path", SqlDbType.NVarChar, 260, folder);
            Add(command, "@take", SqlDbType.Int, 0, take + 1);
            Add(command, "@files", SqlDbType.Bit, 0, extensions.Count > 0 || files.AllFiles == true);
            Add(command, "@all", SqlDbType.Bit, 0, files.AllFiles == true);
            Add(command, "@e1", SqlDbType.NVarChar, 16, extensions.Count > 0 ? extensions[0] : null);
            Add(command, "@e2", SqlDbType.NVarChar, 16, extensions.Count > 1 ? extensions[1] : null);
            await using var reader = await command.ExecuteReaderAsync(token);
            while (await reader.ReadAsync(token))
            {
                var directory = Convert.ToBoolean(reader.GetValue(1), CultureInfo.InvariantCulture);
                entries.Add(modern
                    ? new(reader.GetString(0), directory, directory || reader.IsDBNull(2) ? null : Convert.ToInt64(reader.GetValue(2), CultureInfo.InvariantCulture), reader.IsDBNull(3) ? null : Time(reader.GetValue(3)))
                    : new(reader.GetString(0), directory));
            }
        }
        var truncated = entries.Count > take;
        if (truncated) entries.RemoveRange(take, entries.Count - take);
        var notice = !modern && !facts.Sysadmin && entries.Count == 0 ? "legacyEmpty" : null;
        return (new(separator, folder, [], entries, truncated, notice), null);
    }

    private static string Time(object value) => value switch
    {
        DateTime time => time.ToString("yyyy-MM-ddTHH:mm:ss", CultureInfo.InvariantCulture),
        DateTimeOffset time => time.ToString("yyyy-MM-ddTHH:mm:ss", CultureInfo.InvariantCulture),
        _ => Convert.ToString(value, CultureInfo.InvariantCulture) ?? ""
    };

    private static void Add(SqlCommand command, string name, SqlDbType type, int size, object? value)
    {
        var parameter = size == 0 ? new SqlParameter(name, type) : new SqlParameter(name, type, size);
        parameter.Value = value ?? DBNull.Value;
        command.Parameters.Add(parameter);
    }

    private static async Task<ServerFacts> FactsAsync(SqlConnection connection, CancellationToken token)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = Facts;
        command.CommandTimeout = 0;
        await using var reader = await command.ExecuteReaderAsync(token);
        if (!await reader.ReadAsync(token)) return new(null, null, null, false, false);
        string? Text(int i) => reader.IsDBNull(i) ? null : reader.GetString(i);
        return new(Text(0), Text(1), Text(2), !reader.IsDBNull(3) && reader.GetBoolean(3), !reader.IsDBNull(4) && reader.GetInt32(4) == 3);
    }

    internal static async Task<(bool Exists, bool Directory)> ExistsAsync(SqlConnection connection, string sql, string folder, CancellationToken token)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = sql;
        command.CommandTimeout = 0;
        Add(command, "@path", SqlDbType.NVarChar, 260, folder);
        await using var reader = await command.ExecuteReaderAsync(token);
        if (!await reader.ReadAsync(token)) return (false, false);
        bool Flag(int i) => !reader.IsDBNull(i) && Convert.ToInt32(reader.GetValue(i), CultureInfo.InvariantCulture) == 1;
        return (Flag(0), Flag(1));
    }

    /// <summary>The drives (on Windows; a login the server will not tell has none), then the default data, log and backup
    /// folders, one row per folder, or / on Linux.</summary>
    private static async Task<List<ServerRootDto>> RootsAsync(SqlConnection connection, ServerFacts facts, bool modern, bool linux, int take, CancellationToken token)
    {
        var roots = new List<ServerRootDto>();
        if (linux) roots.Add(new("/", "drive"));
        else
        {
            try
            {
                await using var command = connection.CreateCommand();
                command.CommandText = modern ? Drives : LegacyDrives;
                command.CommandTimeout = 0;
                Add(command, "@take", SqlDbType.Int, 0, take);
                await using var reader = await command.ExecuteReaderAsync(token);
                while (await reader.ReadAsync(token))
                {
                    if (reader.IsDBNull(0)) continue;
                    var drive = reader.GetString(0);
                    var path = modern ? ServerPath.Folder(drive, linux: false) : drive.Length == 1 && char.IsAsciiLetter(drive[0]) ? drive + ":\\" : null;
                    if (path is not null) roots.Add(new(path, "drive", null, reader.IsDBNull(1) ? null : Convert.ToInt64(reader.GetValue(1), CultureInfo.InvariantCulture)));
                }
            }
            catch (SqlException error) when (!token.IsCancellationRequested && ActionErrors.CodeOf(error, connection) is "PERMISSION_DENIED" or "SQL_ERROR") { }
        }
        foreach (var (path, kind) in new[] { (facts.Data, "data"), (facts.Log, "log"), (facts.Backup, "backup") })
        {
            if (string.IsNullOrEmpty(path) || ServerPath.Folder(path, linux) is not { } folder || folder.Length > 260) continue;
            var at = roots.FindIndex(root => ServerPath.Same(root.Path, folder, linux));
            if (at < 0) roots.Add(new(folder, "folder", [kind]));
            else roots[at] = roots[at] with { Defaults = [.. roots[at].Defaults ?? [], kind] };
        }
        return roots;
    }

    // --- Lint -----------------------------------------------------------------------------------------------------------

    private static readonly HashSet<string> Literals =
    [
        "'InstanceDefaultDataPath'", "'InstanceDefaultLogPath'", "'InstanceDefaultBackupPath'", "N'sysadmin'", "N'dm_os_enumerate_filesystem'", "N'dm_os_file_exists'",
        "N'dm_os_enumerate_fixed_drives'", "N'*'"
    ];
    [GeneratedRegex(@"N?'(?:[^']|'')*'")]
    private static partial Regex LiteralPattern();
    [GeneratedRegex(@"@\w+")]
    private static partial Regex Variable();

    /// <summary>Problems with one statement: a metadata function, a literal beyond the allowlist, a variable that is neither a
    /// parameter nor declared, the path anywhere but the file functions' first argument or the procedures' argument, a
    /// listing that is not TOP (@take) with ORDER BY, and dynamic SQL.</summary>
    public static List<string> Lint(string text)
    {
        var problems = new List<string>();
        foreach (var builtin in CatalogSql.Builtins) if (text.Contains(builtin, StringComparison.OrdinalIgnoreCase)) problems.Add("uses " + builtin);
        if (text.Contains("OBJECT_ID(", StringComparison.OrdinalIgnoreCase) || text.Contains("DB_NAME(", StringComparison.OrdinalIgnoreCase)) problems.Add("uses a metadata function");
        if (text.Contains("sp_executesql", StringComparison.OrdinalIgnoreCase) || text.Contains("EXEC (", StringComparison.Ordinal) || text.Contains("EXEC(", StringComparison.Ordinal)) problems.Add("runs dynamic SQL");
        foreach (Match literal in LiteralPattern().Matches(text)) if (!Literals.Contains(literal.Value)) problems.Add("has the literal " + literal.Value);
        var parameters = new HashSet<string>(["@path", "@take", "@files", "@all", "@e1", "@e2", "@d", "@e", "@t"], StringComparer.Ordinal);
        foreach (Match used in Variable().Matches(text)) if (!parameters.Contains(used.Value)) problems.Add("uses " + used.Value);
        var bare = text.Replace("sys.dm_os_enumerate_filesystem(@path, N'*')", "", StringComparison.Ordinal).Replace("sys.dm_os_file_exists(@path)", "", StringComparison.Ordinal)
            .Replace("EXEC master.sys.xp_dirtree @path, 1, 1;", "", StringComparison.Ordinal).Replace("EXEC master.sys.xp_fileexist @path;", "", StringComparison.Ordinal);
        if (bare.Contains("@path", StringComparison.Ordinal)) problems.Add("uses @path outside the file functions' argument");
        if (text.Contains("SELECT TOP", StringComparison.Ordinal) != text.Contains(" ORDER BY ", StringComparison.Ordinal)) problems.Add("is a listing without TOP (@take) and ORDER BY");
        if (text.Contains("SELECT TOP", StringComparison.Ordinal) && !text.Contains("SELECT TOP (@take) ", StringComparison.Ordinal)) problems.Add("takes other than @take");
        return problems;
    }

    public static IEnumerable<(string Name, List<string> Problems)> LintAll() =>
    [
        ("server files facts", Lint(Facts)), ("server files drives", Lint(Drives)), ("server files legacy drives", Lint(LegacyDrives)), ("server files exists", Lint(Exists)),
        ("server files legacy exists", Lint(LegacyExists)), ("server files list", Lint(List)), ("server files legacy list", Lint(LegacyList))
    ];
}
