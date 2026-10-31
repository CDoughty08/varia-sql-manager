using System.Text.RegularExpressions;
using Varia.Backend.Explorer;
using Varia.Backend.Scripting;

namespace Varia.Backend.Actions;

/// <summary>A validated file: its logical name, type (rows, log or filestream, a FILESTREAM or memory-optimized container), filegroup
/// (none for a log), size in MB (none for a container), autogrowth, and the folder and file name on the server.</summary>
internal sealed record NewFilePlan(string Name, string Type, string? Filegroup, long? SizeMb, GrowthDto Growth, string Path, string FileName)
{
    public bool Container => Type == "filestream";
    public bool Log => Type == "log";
}

/// <summary>A validated filegroup: PRIMARY first; Type rows, filestream or memoryOptimized.</summary>
internal sealed record NewFilegroupPlan(string Name, string Type, bool ReadOnly, bool IsDefault, bool AutogrowAllFiles);

/// <summary>New Database's validated design: the name, files in the order CREATE DATABASE lists them (PRIMARY's, then each
/// filegroup's in filegroup order, then the log files), the filegroups, and what runs after CREATE.</summary>
internal sealed record NewDatabasePlan(string Name, string? Owner, IReadOnlyList<NewFilePlan> Files, IReadOnlyList<NewFilegroupPlan> Filegroups, string? Collation, string Containment,
    bool Ledger, Dictionary<string, string> Options, Dictionary<string, string> Scoped)
{
    /// <summary>The filegroup changes after CREATE, as src/shared/actions/new-database.ts' filegroupChanges orders them.</summary>
    public IEnumerable<(AlterTemplate Template, string Filegroup)> FilegroupChanges()
    {
        var rows = Filegroups.Where(group => group.Type == "rows").ToList();
        foreach (var group in rows.Where(group => group.AutogrowAllFiles)) yield return (AlterTemplate.FilegroupAutogrowAll, group.Name);
        foreach (var group in rows.Where(group => group.IsDefault && group.Name != NewDatabaseValidator.Primary)) yield return (AlterTemplate.FilegroupDefault, group.Name);
        foreach (var group in rows.Where(group => group.ReadOnly)) yield return (AlterTemplate.FilegroupReadOnly, group.Name);
    }
}

/// <summary>What the preflight read about the server for the rules only it decides (src/shared/actions/new-database.ts' NewDatabaseFacts).</summary>
internal sealed record NewDatabaseFacts(int Level, bool Linux, int FilestreamLevel, bool ContainedAuthentication);

/// <summary>Re-validates what src/shared/actions/schema.ts' createDatabase schema and newDatabaseProblems accept (critic A23 for the
/// file names), and orders the files as CREATE DATABASE lists them. Messages never echo values. <see cref="ServerProblem"/> adds the
/// rules the server decides: its platform's paths and file names, ledger's version, contained database authentication and FILESTREAM.</summary>
internal static partial class NewDatabaseValidator
{
    public const string Primary = "PRIMARY";
    private static RequestException Invalid(string detail) => new("INVALID_PARAMS", "Invalid object action request: " + detail);
    private static readonly string[] SystemNames = ["master", "model", "msdb", "tempdb"];
    /// <summary>The options CREATE DATABASE itself writes, so New Database never sends them as ALTER (new-database.ts' createOptionKeys).</summary>
    private static readonly HashSet<string> CreateOptions = new(["collation", "containmentType"], StringComparer.Ordinal);
    [GeneratedRegex(@"^[A-Za-z0-9_]{1,128}\z")]
    private static partial Regex CollationPattern();
    [GeneratedRegex(@"^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|\z)", RegexOptions.IgnoreCase)]
    private static partial Regex WindowsReserved();

    /// <summary>The separator a path uses when the server's platform is not known yet: a Linux path starts with /.</summary>
    public static char SeparatorOf(string path) => path.StartsWith('/') ? '/' : '\\';

    /// <summary>The file's full path on a server with this separator: its folder (on Windows with backslashes), the separator and its name.</summary>
    public static string FullPath(NewFilePlan file, char separator)
    {
        var folder = separator == '\\' ? file.Path.Replace('/', '\\') : file.Path;
        return (folder.EndsWith(separator) ? folder : folder + separator) + file.FileName;
    }

    /// <summary>new-database.ts' fileNameProblem: whether a file name can be one on a platform with this separator.</summary>
    public static bool FileNameValid(string name, char separator, long max)
    {
        if (name.Length == 0 || name.Length > max || name is "." or "..") return false;
        for (var i = 0; i < name.Length; i++)
        {
            var c = name[i];
            // SQL Server on Linux reads a backslash as a separator too, so no file name holds one on either platform.
            if (c < 0x20 || c is '/' or '\\' or '*' or '?' or '"' or '<' or '>' or '|') return false;
            if (separator == '\\' && c == ':') return false;
            if (char.IsHighSurrogate(c) && (i + 1 == name.Length || !char.IsLowSurrogate(name[++i]))) return false;
            if (char.IsLowSurrogate(c)) return false;
        }
        return separator != '\\' || !(name.EndsWith('.') || name.EndsWith(' ') || WindowsReserved().IsMatch(name));
    }

    private static bool Whole(long? value, long min, long max) => value is { } number && number >= min && number <= max;

    public static NewDatabasePlan Validate(ActionsCatalog catalog, string name, NewDatabaseDesignDto? design)
    {
        if (design is null) throw Invalid("design is required.");
        if (!ExplorerRefs.Ident(name) || name.Trim().Length == 0) throw Invalid("target.name.");
        if (SystemNames.Contains(name.ToLowerInvariant())) throw Invalid("a system database's name.");
        if (design.Owner is not null && !ExplorerRefs.Ident(design.Owner)) throw Invalid("design.owner.");
        if (design.Collation is not null && !CollationPattern().IsMatch(design.Collation)) throw Invalid("design.collation.");
        if (design.Containment is not ("NONE" or "PARTIAL")) throw Invalid("design.containment.");
        if (design.Files is null || design.Filegroups is null || design.Options is null || design.Scoped is null) throw Invalid("design.");

        // Filegroups: PRIMARY first, distinct names, at most one default per kind and one memory-optimized filegroup.
        var groups = design.Filegroups;
        if (groups.Count is 0 || groups.Count > catalog.Limit("newDatabaseFilegroups")) throw Invalid("design.filegroups.");
        if (groups[0].Name != Primary || groups[0].Type != "rows") throw Invalid("PRIMARY must be the first filegroup.");
        var groupNames = new Dictionary<string, NewFilegroupPlan>(StringComparer.OrdinalIgnoreCase);
        var plannedGroups = new List<NewFilegroupPlan>();
        foreach (var (group, index) in groups.Select((group, index) => (group, index)))
        {
            if (group is null || !ExplorerRefs.Ident(group.Name) || group.Type is not ("rows" or "filestream" or "memoryOptimized")) throw Invalid("design.filegroups.");
            var grouped = new NewFilegroupPlan(group.Name, group.Type, group.ReadOnly == true, group.IsDefault == true, group.AutogrowAllFiles == true);
            if (!groupNames.TryAdd(group.Name, grouped)) throw Invalid("two filegroups have one name.");
            if (grouped.Type != "rows" && (grouped.ReadOnly || grouped.AutogrowAllFiles)) throw Invalid("Read-Only and Autogrow All Files apply to rows filegroups only.");
            if (grouped.Type == "memoryOptimized" && grouped.IsDefault) throw Invalid("a memory-optimized filegroup is never the default.");
            if (grouped.ReadOnly && (index == 0 || grouped.IsDefault)) throw Invalid("PRIMARY and the default filegroup stay read-write.");
            plannedGroups.Add(grouped);
        }
        if (plannedGroups.Count(group => group.Type == "rows" && group.IsDefault) > 1 || plannedGroups.Count(group => group.Type == "filestream" && group.IsDefault) > 1) throw Invalid("one default filegroup per kind.");
        if (plannedGroups.Count(group => group.Type == "memoryOptimized") > 1) throw Invalid("at most one memory-optimized filegroup.");

        // Files: the first is a rows file in PRIMARY, a log file, sizes and growth in their bounds, distinct names and paths.
        var files = design.Files;
        if (files.Count < 2 || files.Count > catalog.Limit("newDatabaseFiles")) throw Invalid("design.files.");
        if (files[0] is not { Type: "rows", Filegroup: Primary }) throw Invalid("the first file must be a ROWS data file in PRIMARY.");
        if (!files.Any(file => file?.Type == "log")) throw Invalid("a database needs a log file.");
        var serverPath = catalog.Limit("serverPath");
        var fileNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var paths = new HashSet<string>(StringComparer.Ordinal);
        var planned = new List<NewFilePlan>();
        foreach (var file in files)
        {
            if (file is null || !ExplorerRefs.Ident(file.Name) || file.Type is not ("rows" or "log" or "filestream") || file.Growth is null) throw Invalid("design.files.");
            if (!fileNames.Add(file.Name)) throw Invalid("two files have one name.");
            NewFilegroupPlan? group = null;
            if (file.Type == "log" ? file.Filegroup is not null : file.Filegroup is null || !groupNames.TryGetValue(file.Filegroup, out group) || group.Name != file.Filegroup) throw Invalid("a file's filegroup.");
            if (file.Type == "rows" && group!.Type != "rows" || file.Type == "filestream" && group!.Type == "rows") throw Invalid("a file's type does not suit its filegroup.");
            var ceiling = catalog.Limit(file.Type == "log" ? "logFileMb" : "dataFileMb");
            if (file.Type == "filestream" ? file.SizeMb is not null : !Whole(file.SizeMb, 1, ceiling)) throw Invalid("a file's size.");
            var growth = file.Growth;
            if (!growth.Enabled)
            {
                if (growth.Unit is not null || growth.By is not null || growth.MaxMb is not null) throw Invalid("a file's growth.");
            }
            else if (file.Type == "filestream" || growth.Unit is not ("mb" or "percent") || !Whole(growth.By, 1, catalog.Limit(growth.Unit == "mb" ? "growthMb" : "growthPercent"))
                || growth.MaxMb is { } max && (!Whole(max, file.SizeMb ?? 1, ceiling) || growth.Unit == "mb" && growth.By > max)) throw Invalid("a file's growth.");
            if (!ServerPath.Valid(file.Path, serverPath)) throw Invalid("a file's path.");
            var separator = SeparatorOf(file.Path);
            if (file.FileName is null || !FileNameValid(file.FileName, separator, serverPath)) throw Invalid("a file name.");
            var plan = new NewFilePlan(file.Name, file.Type, file.Filegroup, file.SizeMb, growth, file.Path, file.FileName);
            var full = FullPath(plan, separator);
            if (!ServerPath.Valid(full, serverPath)) throw Invalid("a file's full path.");
            if (!paths.Add(separator == '\\' ? full.ToLowerInvariant() : full)) throw Invalid("two files have one path.");
            planned.Add(plan);
        }
        foreach (var group in plannedGroups)
            if (!planned.Any(file => !file.Log && string.Equals(file.Filegroup, group.Name, StringComparison.OrdinalIgnoreCase))) throw Invalid("a filegroup has no files.");

        // Options and scoped configurations: only those New Database sends, with their own tokens.
        foreach (var (key, token) in design.Options)
            if (CreateOptions.Contains(key) || !catalog.DatabaseOptions.TryGetValue(key, out var option) || !option.Settable || token is not { Length: >= 1 and <= 128 } || !DatabaseAlter.TokenValid(option, token))
                throw Invalid("design.options.");
        foreach (var (key, token) in design.Scoped)
            if (!catalog.ScopedConfigurations.TryGetValue(key, out var option) || !option.Settable || token is not { Length: >= 1 and <= 128 } || !DatabaseAlter.TokenValid(option, token))
                throw Invalid("design.scoped.");
        if (design.Options.ContainsKey("autoCreateIncrementalStatistics") && design.Options.GetValueOrDefault("autoCreateStatistics") == "false") throw Invalid("incremental statistics need Auto Create Statistics.");

        // CREATE DATABASE lists PRIMARY's files, then each filegroup's, then the log files.
        var order = plannedGroups.Select((group, index) => (group.Name, index)).ToDictionary(item => item.Name, item => item.index, StringComparer.OrdinalIgnoreCase);
        var ordered = planned.Select((file, index) => (file, index)).OrderBy(item => item.file.Log ? int.MaxValue : order[item.file.Filegroup!]).ThenBy(item => item.index).Select(item => item.file).ToList();
        var result = new NewDatabasePlan(name, design.Owner, ordered, plannedGroups, design.Collation, design.Containment, design.Ledger == true,
            new(design.Options, StringComparer.Ordinal), new(design.Scoped, StringComparer.Ordinal));
        // Database Read-Only refuses what SQL Server would refuse after it (DatabaseAlter.Plan checks the options themselves).
        if (design.Options.GetValueOrDefault("readOnly") == "true" && (result.FilegroupChanges().Any() || design.Owner is not null)) throw Invalid("a change after Database Read-Only.");
        var shared = design.Options.ContainsKey("autoCreateStatistics") && design.Options.ContainsKey("autoCreateIncrementalStatistics") ? 1 : 0;
        if (1 + design.Options.Count - shared + design.Scoped.Count + result.FilegroupChanges().Count() + (design.Owner is null ? 0 : 1) > catalog.Limit("statements")) throw Invalid("too many changes.");
        return result;
    }

    /// <summary>Why the server refuses the design, as a user's message (never a value from the design but the file's own name), or null:
    /// its platform's paths and file names, ledger before SQL Server 2022, Partial containment without contained database authentication,
    /// and FILESTREAM on Linux or where it is not enabled.</summary>
    public static (string Code, string Message)? ServerProblem(ActionsCatalog catalog, NewDatabasePlan plan, NewDatabaseFacts facts)
    {
        var separator = facts.Linux ? '/' : '\\';
        var serverPath = catalog.Limit("serverPath");
        var paths = new HashSet<string>(facts.Linux ? StringComparer.Ordinal : StringComparer.OrdinalIgnoreCase);
        foreach (var file in plan.Files)
        {
            var display = ScriptingErrors.Display(file.Name);
            if (ServerPath.Folder(file.Path, facts.Linux) is null)
                return ("PATH_NOT_FOUND", "The path of " + display + " is not a full path on this server" + (facts.Linux ? " (SQL Server runs on Linux, so paths start with /)." : "."));
            if (!FileNameValid(file.FileName, separator, serverPath)) return ("NOT_SUPPORTED", "The file name of " + display + " is not one this server's platform allows.");
            var full = FullPath(file, separator);
            if (!ServerPath.Valid(full, serverPath)) return ("NOT_SUPPORTED", "The full path of " + display + " is longer than " + serverPath + " characters.");
            if (!paths.Add(full)) return ("NOT_SUPPORTED", "Two files have the same path on this server.");
        }
        if (plan.Ledger && facts.Level < 16) return ("NOT_SUPPORTED", "A ledger database needs SQL Server 2022 or later.");
        if (plan.Containment == "PARTIAL" && !facts.ContainedAuthentication) return ("NOT_SUPPORTED", "Partial containment needs the server option contained database authentication.");
        if (plan.Filegroups.Any(group => group.Type == "filestream"))
        {
            if (facts.Linux) return ("NOT_SUPPORTED", "SQL Server on Linux has no FILESTREAM.");
            if (facts.FilestreamLevel == 0) return ("NOT_SUPPORTED", "FILESTREAM is not enabled on this server.");
        }
        return null;
    }
}
