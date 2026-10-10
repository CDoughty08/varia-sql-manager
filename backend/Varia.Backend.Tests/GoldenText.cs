using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Varia.Backend.Tests;

/// <summary>Golden Script As output (spec G4, G5): tests/fixtures/scripting/golden/16 holds the baseline from SQL Server
/// 2022, golden/{14,15,17} only the files another major writes differently, and golden/manifest.json each file's source:
/// "varia" for files this suite wrote, "ssms-&lt;version&gt;" for files compare-ssms-scripts.mjs matched to an SSMS
/// capture. VARIA_UPDATE_SCRIPT_GOLDENS=1 rewrites varia files only; an SSMS file changes only with a new capture.</summary>
internal sealed class GoldenText
{
    public const int BaselineMajor = 16;
    private readonly (Regex Pattern, string Replacement)[] rules;
    private readonly SortedDictionary<string, string> manifest;
    private bool manifestChanged;

    private GoldenText(string folder, (Regex, string)[] rules, SortedDictionary<string, string> manifest)
    {
        Folder = folder;
        this.rules = rules;
        this.manifest = manifest;
    }

    /// <summary>tests/fixtures/scripting in the repository the tests were built from.</summary>
    public string Folder { get; }
    public bool Updating { get; } = Environment.GetEnvironmentVariable("VARIA_UPDATE_SCRIPT_GOLDENS") == "1";
    public string GoldenFolder => Path.Combine(Folder, "golden");

    /// <summary>The repository root: the first folder above the test binaries that has tests/fixtures/scripting.</summary>
    public static string Repository()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
            if (File.Exists(Path.Combine(directory.FullName, "tests", "fixtures", "scripting", "cases.json"))) return directory.FullName;
        throw new InvalidOperationException("tests/fixtures/scripting was not found above " + AppContext.BaseDirectory);
    }

    public static GoldenText Load(string? folder = null)
    {
        folder ??= Path.Combine(Repository(), "tests", "fixtures", "scripting");
        var normalize = JsonNode.Parse(File.ReadAllText(Path.Combine(folder, "normalize.json")))!;
        var rules = normalize["rules"]!.AsArray().Select(rule => (new Regex(rule!["pattern"]!.GetValue<string>(), RegexOptions.CultureInvariant), rule["replacement"]!.GetValue<string>())).ToArray();
        var path = Path.Combine(folder, "golden", "manifest.json");
        var manifest = new SortedDictionary<string, string>(StringComparer.Ordinal);
        if (File.Exists(path))
            foreach (var (key, value) in JsonNode.Parse(File.ReadAllText(path))!["files"]!.AsObject()) manifest[key] = value!.GetValue<string>();
        return new GoldenText(folder, rules, manifest);
    }

    /// <summary>Spec G5's normalization, every rule of normalize.json in order and nothing else.</summary>
    public string Normalize(string text)
    {
        foreach (var (pattern, replacement) in rules) text = pattern.Replace(text, replacement);
        return text;
    }

    public IReadOnlyDictionary<string, string> Manifest => manifest;

    private static string Key(int major, string id) => major.ToString(System.Globalization.CultureInfo.InvariantCulture) + "/" + id + ".sql";
    private string PathOf(string key) => Path.Combine(GoldenFolder, key.Replace('/', Path.DirectorySeparatorChar));
    private string? Read(string key) => File.Exists(PathOf(key)) ? File.ReadAllText(PathOf(key), Encoding.UTF8) : null;

    /// <summary>The golden a major compares with: its own overlay, else the baseline.</summary>
    public (string Key, string? Text) Expected(int major, string id)
    {
        if (major != BaselineMajor && Read(Key(major, id)) is { } overlay) return (Key(major, id), overlay);
        return (Key(BaselineMajor, id), Read(Key(BaselineMajor, id)));
    }

    /// <summary>Compares a normalized script with its golden; when updating, rewrites a varia golden instead: the baseline
    /// for SQL Server 2022, otherwise an overlay that exists only while it differs from the baseline. An SSMS golden is
    /// still compared. Returns the problem, or null.</summary>
    public string? Compare(int major, string id, string actual)
    {
        var own = Key(major, id);
        if (Updating && (!manifest.TryGetValue(own, out var source) || source == "varia"))
        {
            var baseline = Read(Key(BaselineMajor, id));
            if (major == BaselineMajor) { if (baseline != actual) Write(own, actual); }
            else if (baseline == actual) Remove(own);
            else if (Read(own) != actual) Write(own, actual);
            if (File.Exists(PathOf(own)) && manifest.TryAdd(own, "varia")) manifestChanged = true;
            return null;
        }
        var (key, expected) = Expected(major, id);
        if (expected == actual) return null;
        return expected is null ? "no golden " + own + " (run with VARIA_UPDATE_SCRIPT_GOLDENS=1)" : key + " differs at " + FirstDifference(expected, actual);
    }

    private void Write(string key, string text)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(PathOf(key))!);
        File.WriteAllText(PathOf(key), text, new UTF8Encoding(false));
        if (!manifest.TryGetValue(key, out var source) || source != "varia") { manifest[key] = "varia"; manifestChanged = true; }
    }

    private void Remove(string key)
    {
        if (File.Exists(PathOf(key))) File.Delete(PathOf(key));
        if (manifest.Remove(key)) manifestChanged = true;
    }

    /// <summary>Writes manifest.json after an update run (sorted keys, one file per line).</summary>
    public void Save()
    {
        if (!manifestChanged) return;
        var text = new StringBuilder("{\n  \"version\": 1,\n  \"files\": {\n");
        text.Append(string.Join(",\n", manifest.Select(item => "    " + JsonSerializer.Serialize(item.Key) + ": " + JsonSerializer.Serialize(item.Value))));
        text.Append("\n  }\n}\n");
        File.WriteAllText(Path.Combine(GoldenFolder, "manifest.json"), text.ToString(), new UTF8Encoding(false));
        manifestChanged = false;
    }

    /// <summary>"line 12: expected `…` but got `…`", with hidden characters made visible.</summary>
    public static string FirstDifference(string expected, string actual)
    {
        var a = expected.Split('\n');
        var b = actual.Split('\n');
        for (var i = 0; i < Math.Max(a.Length, b.Length); i++)
        {
            var x = i < a.Length ? a[i] : "<end>";
            var y = i < b.Length ? b[i] : "<end>";
            if (x != y) return "line " + (i + 1) + ": expected `" + Show(x) + "` but got `" + Show(y) + "`";
        }
        return "the same lines (length " + expected.Length + " vs " + actual.Length + ")";
    }

    private static string Show(string line) => (line.Length > 160 ? line[..160] + "…" : line).Replace("\r", "\\r").Replace("\t", "\\t");
}
