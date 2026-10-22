using System.Text.RegularExpressions;

namespace Varia.Backend.Tests;

/// <summary>Offline checks of the SSIS catalog fixtures (PR S0): manifest.json is in canonical form and the drift comparison
/// finds each kind of difference; the backup path follows the engine's service path; and the fake's hand-written procedures
/// keep to the real catalog's names, refusals and error numbers and never reach for the real catalog or the server.</summary>
internal static partial class SsisFixtureChecks
{
    [GeneratedRegex(@"CREATE PROCEDURE \[catalog\]\.\[(\w+)\]")]
    private static partial Regex Procedure();
    [GeneratedRegex(@"RAISERROR\((\d+),")]
    private static partial Regex Raised();
    [GeneratedRegex(@"CREATE TABLE \[catalog\]\.\[(\w+)\]")]
    private static partial Regex Table();

    public static void Run(Action<bool, string> check)
    {
        var folder = SsisManifest.Folder();
        var text = File.ReadAllText(SsisManifest.PathOf());
        var manifest = SsisManifest.Parse(text);
        check(SsisManifest.Write(manifest) == text && manifest.Comment == SsisManifest.Comment, "manifest.json is in the canonical form its writer produces");
        check(manifest.Catalogs.Select(entry => entry.Band).SequenceEqual(manifest.Catalogs.Select(entry => entry.Band).Distinct().Order()) && manifest.Catalogs.Any(entry => entry.Band == 17),
            "manifest.json holds one entry per band, in order, SQL Server 2025's among them");
        var shape = manifest.Catalogs[^1];
        check(shape.Views.Count > 20 && shape.Procedures.Count > 40 && shape.Views.Values.All(columns => columns.Count > 0) && shape.SqlAuthRefused.All(shape.Procedures.ContainsKey)
            && SsisManifest.ErrorNumbers.All(number => shape.Errors.ContainsKey(number.ToString(System.Globalization.CultureInfo.InvariantCulture))),
            "the newest manifest entry has the catalog's views with their columns, its procedures, a refusal list naming only them, and every error number the fake raises");

        // The drift comparison: equal shapes compare equal, and each kind of change is reported by name.
        check(SsisManifest.Compare(shape, shape).Count == 0, "a catalog shape matches itself");
        static Dictionary<string, List<T>> Changed<T>(Dictionary<string, List<T>> map, string key, Func<List<T>, List<T>> change) =>
            map.ToDictionary(pair => pair.Key, pair => pair.Key == key ? change([.. pair.Value]) : pair.Value, StringComparer.Ordinal);
        var dropped = shape with { Views = Changed(shape.Views, "operations", columns => [.. columns.Where(column => column.Name != "status")]) };
        var retyped = shape with { Views = Changed(shape.Views, "operation_messages", columns => [.. columns.Select(column => column.Name == "message" ? column with { MaxLength = 8000 } : column)]) };
        var nullable = shape with { Views = Changed(shape.Views, "executions", columns => [.. columns.Select(column => column.Name == "execution_id" ? column with { Nullable = true } : column)]) };
        var parameter = shape with { Procedures = Changed(shape.Procedures, "start_execution", parameters => [.. parameters, new ShapeParameter("@synchronized", "bit", 1, false)]) };
        var refusal = shape with { SqlAuthRefused = [.. shape.SqlAuthRefused.Where(name => name != "stop_operation")] };
        var key = shape with { ForeignKeys = [.. shape.ForeignKeys.Where(foreign => foreign.Name != "FK_EventMessages_OperationMessageId_OperationMessage")] };
        var extra = shape with { Views = new(shape.Views, StringComparer.Ordinal) { ["varia_extra"] = [new("id", "int", 4, 10, 0, false)] } };
        string Found(CatalogShape actual, bool fake = false) => string.Join("; ", SsisManifest.Compare(shape, actual, fake));
        check(Found(dropped).Contains("view operations", StringComparison.Ordinal) && Found(retyped).Contains("view operation_messages differs at message", StringComparison.Ordinal)
            && Found(nullable).Contains("view executions differs at execution_id", StringComparison.Ordinal) && Found(parameter).Contains("procedure start_execution", StringComparison.Ordinal)
            && Found(refusal).Contains("lacks stop_operation", StringComparison.Ordinal) && Found(key).Contains("FK_EventMessages_OperationMessageId_OperationMessage", StringComparison.Ordinal)
            && Found(extra).Contains("view varia_extra is not in the manifest", StringComparison.Ordinal),
            "the drift check reports a missing column, a changed length, a changed nullability, an added parameter, a lost SQL authentication refusal, a lost foreign key and an extra view");
        var fake = shape with
        {
            Procedures = shape.Procedures.Where(pair => pair.Key is "create_execution" or "stop_operation").ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal),
            SqlAuthRefused = ["create_execution", "stop_operation"], Functions = [], Identities = [], Indexes = [], ForeignKeys = [], TypeMapping = [], Errors = [], SchemaVersion = ""
        };
        check(SsisManifest.Compare(shape, fake, fake: true).Count == 0 && Found(fake with { SqlAuthRefused = ["create_execution"] }, fake: true).Contains("lacks stop_operation", StringComparison.Ordinal)
            && Found(fake with { Procedures = Changed(fake.Procedures, "stop_operation", parameters => [.. parameters.Select(item => item with { Type = "int" })]) }, fake: true).Contains("procedure stop_operation", StringComparison.Ordinal),
            "the fake's comparison asks only for the procedures it stubs, with their real parameters and refusals");

        // The catalog backup: next to the engine's version folder, under 2025's own file name.
        const string Engine = "\"C:\\Program Files\\Microsoft SQL Server\\MSSQL17.MSSQLSERVER\\MSSQL\\Binn\\sqlservr.exe\" -sMSSQLSERVER";
        check(SsisManifest.BackupPath(Engine, 17) == @"C:\Program Files\Microsoft SQL Server\170\DTS\Binn\SSISDBBackup.bak"
            && SsisManifest.BackupPath("\"D:\\SQL\\MSSQL16.SQL2022\\MSSQL\\Binn\\sqlservr.exe\" -sSQL2022", 16) == @"D:\SQL\160\DTS\Binn\SSISDB.bak"
            && SsisManifest.BackupPath("/opt/mssql/bin/sqlservr", 16) is null && SsisManifest.BackupPath(null, 17) is null && SsisManifest.BackupPath("\"C:\\Tools\\sqlservr.exe\"", 17) is null,
            "the catalog backup's path comes from the engine's service path (SSISDBBackup.bak on SQL Server 2025), and there is none for a Linux engine");

        // The fake's procedures: the four stubs and the fake's own helpers, nothing that reaches the real catalog or the server.
        var procedures = File.ReadAllText(Path.Combine(folder, "procedures.sql"));
        var code = string.Join("\n", procedures.Split('\n').Select(line => line.Contains("--", StringComparison.Ordinal) ? line[..line.IndexOf("--", StringComparison.Ordinal)] : line));
        var names = Procedure().Matches(procedures).Select(match => match.Groups[1].Value).ToList();
        var stubs = names.Where(name => !name.StartsWith("varia_", StringComparison.Ordinal)).ToList();
        check(stubs.Order(StringComparer.Ordinal).SequenceEqual(["create_execution", "set_execution_parameter_value", "start_execution", "stop_operation"])
            && stubs.All(shape.Procedures.ContainsKey) && stubs.All(shape.SqlAuthRefused.Contains)
            && names.Where(name => name.StartsWith("varia_", StringComparison.Ordinal)).Order(StringComparer.Ordinal).SequenceEqual(["varia_fake_finish", "varia_fake_run", "varia_fake_seed"]),
            "the fake stubs create_execution, set_execution_parameter_value, start_execution and stop_operation, all real procedures that refuse SQL Server authentication, plus its own varia_ helpers");
        var raised = Raised().Matches(procedures).Select(match => match.Groups[1].Value).Distinct().ToList();
        check(raised.Count >= 8 && raised.All(shape.Errors.ContainsKey), "every error the fake raises is a real catalog error number: " + string.Join(", ", raised.Where(number => !shape.Errors.ContainsKey(number))));
        check(!new[] { "SSISDB", "ISServerExec", "xp_", "sp_configure", "RECONFIGURE", "SYNCHRONIZED", "OPENROWSET", "EXTERNAL NAME", "sp_add_trusted_assembly" }
            .Any(word => code.Contains(word, StringComparison.OrdinalIgnoreCase)), "the fake's procedures name no real catalog, process, server setting or assembly");
        var schema = File.ReadAllText(Path.Combine(folder, "schema.sql"));
        check(schema.StartsWith("-- Generated from manifest.json", StringComparison.Ordinal) && Table().Matches(schema).Select(match => match.Groups[1].Value).SequenceEqual(shape.Views.Keys.Order(StringComparer.Ordinal)),
            "schema.sql is generated from the newest manifest entry, one table per catalog view");
    }
}
