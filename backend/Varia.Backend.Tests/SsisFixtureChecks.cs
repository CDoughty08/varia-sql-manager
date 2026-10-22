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
    [GeneratedRegex(@"CREATE VIEW \[catalog\]\.\[(\w+)\]")]
    private static partial Regex View();

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
        static Dictionary<string, List<T>> Without<T>(Dictionary<string, List<T>> map, string key) =>
            map.Where(pair => pair.Key != key).ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);
        var defaulted = shape with { Procedures = Changed(shape.Procedures, "create_execution", parameters => [.. parameters.Select(item => item.Name == "@useanyworker" ? item with { Default = "NULL" } : item)]) };
        check(Found(shape with { Views = Without(shape.Views, "worker_agents") }).Contains("view worker_agents is missing", StringComparison.Ordinal)
            && Found(shape with { Procedures = Without(shape.Procedures, "stop_operation") }).Contains("procedure stop_operation is missing", StringComparison.Ordinal)
            && Found(shape with { Functions = Without(shape.Functions, "get_operation_log_size") }).Contains("function get_operation_log_size is missing", StringComparison.Ordinal)
            && Found(defaulted).Contains("procedure create_execution differs at @useanyworker", StringComparison.Ordinal),
            "the drift check reports a catalog without a view, a procedure or a function the manifest has, and a parameter whose default changed");
        var fake = shape with
        {
            Procedures = shape.Procedures.Where(pair => pair.Key is "create_execution" or "stop_operation").ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal),
            SqlAuthRefused = ["create_execution", "stop_operation"], Functions = [], Identities = [], Indexes = [], ForeignKeys = [], TypeMapping = [], Errors = [], SchemaVersion = ""
        };
        check(SsisManifest.Compare(shape, fake, fake: true).Count == 0 && Found(fake with { SqlAuthRefused = ["create_execution"] }, fake: true).Contains("lacks stop_operation", StringComparison.Ordinal)
            && Found(fake with { Procedures = Changed(fake.Procedures, "stop_operation", parameters => [.. parameters.Select(item => item with { Type = "int" })]) }, fake: true).Contains("procedure stop_operation", StringComparison.Ordinal)
            && Found(fake with { Views = Without(fake.Views, "executions") }, fake: true).Contains("view executions is missing", StringComparison.Ordinal),
            "the fake's comparison asks only for the procedures it stubs, with their real parameters and refusals, and still for every view");

        // Parameter defaults come from the module's text: the declaration (the first use of a name outside comments), never a
        // later assignment.
        var defaults = SsisManifest.Defaults("-- @a int = 5 in a comment\n/* @b bit = 0 /* nested */ */\nCREATE PROCEDURE [catalog].[p]\n    @a int = null, -- @c int = 9\n    @b bit = 1,\n"
            + "    @c nvarchar(128) = N'x, ''y'' -- not a comment',\n    @d bigint OUTPUT,\n    @e [internal].[adt_sensitive] = -1,\n    @f decimal(5, 2)\nWITH EXECUTE AS 'AllSchemaOwner'\nAS\nBEGIN\n    SET @d = 2;\n    DECLARE @g int = 3;\nEND");
        check(defaults.Count == 5 && defaults["@a"] == "NULL" && defaults["@b"] == "1" && defaults["@c"] == "N'x, ''y'' -- not a comment'" && defaults["@e"] == "-1" && defaults["@g"] == "3"
            && !defaults.ContainsKey("@d") && !defaults.ContainsKey("@f"),
            "a parameter's default is read from its first declaration in the module's text outside comments, NULL in capitals, quoted strings whole (" + string.Join(", ", defaults.Select(pair => pair.Key + "=" + pair.Value)) + ")");

        // The catalog backup: <shared features>\<major>0\DTS\Binn, under 2025's own file name. The shared-features folder is
        // taken to be the folder above MSSQL<n>.<instance>, which holds only when Setup put the instance and the shared features
        // under one root (the defaults do); docs/integration-services.md 14.12.
        const string Engine = "\"C:\\Program Files\\Microsoft SQL Server\\MSSQL17.MSSQLSERVER\\MSSQL\\Binn\\sqlservr.exe\" -sMSSQLSERVER";
        check(SsisManifest.BackupPath(Engine, 17) == @"C:\Program Files\Microsoft SQL Server\170\DTS\Binn\SSISDBBackup.bak"
            && SsisManifest.BackupPath("\"C:\\Program Files\\Microsoft SQL Server\\MSSQL16.SQL2022\\MSSQL\\Binn\\sqlservr.exe\" -sSQL2022", 16) == @"C:\Program Files\Microsoft SQL Server\160\DTS\Binn\SSISDB.bak"
            && SsisManifest.BackupPath("/opt/mssql/bin/sqlservr", 16) is null && SsisManifest.BackupPath(null, 17) is null && SsisManifest.BackupPath("\"C:\\Tools\\sqlservr.exe\"", 17) is null,
            "with the default install folders the catalog backup's path follows the engine's service path (SSISDBBackup.bak on SQL Server 2025, SSISDB.bak before), and there is none for a Linux engine");

        // The fake's procedures: the four stubs and the fake's own helpers, nothing that reaches the real catalog or the server.
        var procedures = File.ReadAllText(Path.Combine(folder, "procedures.sql"));
        var code = string.Join("\n", procedures.Split('\n').Select(line => line.Contains("--", StringComparison.Ordinal) ? line[..line.IndexOf("--", StringComparison.Ordinal)] : line));
        var names = Procedure().Matches(procedures).Select(match => match.Groups[1].Value).ToList();
        var stubs = names.Where(name => !name.StartsWith("varia_", StringComparison.Ordinal)).ToList();
        check(stubs.Order(StringComparer.Ordinal).SequenceEqual(["create_execution", "set_execution_parameter_value", "start_execution", "stop_operation"])
            && stubs.All(shape.Procedures.ContainsKey) && stubs.All(shape.SqlAuthRefused.Contains)
            && names.Where(name => name.StartsWith("varia_", StringComparison.Ordinal)).Order(StringComparer.Ordinal).SequenceEqual(["varia_fake_finish", "varia_fake_run", "varia_fake_seed"]),
            "the fake stubs create_execution, set_execution_parameter_value, start_execution and stop_operation, all real procedures that refuse SQL Server authentication, plus its own varia_ helpers");
        // Each stub refuses SQL Server authentication before it checks anything else, as the real procedure does; only the real
        // stop_operation checks for a null id (27100) first, before internal.prepare_stop refuses.
        string Body(string name)
        {
            var start = code.IndexOf("CREATE PROCEDURE [catalog].[" + name + "]", StringComparison.Ordinal);
            var end = code.IndexOf("\nGO", start, StringComparison.Ordinal);
            return string.Concat(code[start..end].Where(character => !char.IsWhiteSpace(character)));
        }
        var refusals = stubs.ToDictionary(name => name, name => (Body(name), Raised().Matches(Body(name)).Select(match => match.Groups[1].Value).ToList()));
        check(refusals.All(pair => pair.Value.Item1.Contains("IF[catalog].[varia_fake_sql_auth]()=1BEGINRAISERROR(27123,", StringComparison.Ordinal)
                && pair.Value.Item2.Take(pair.Key == "stop_operation" ? 2 : 1).SequenceEqual(pair.Key == "stop_operation" ? ["27100", "27123"] : ["27123"])),
            "every stub raises 27123 for SQL Server authentication before any other error, stop_operation after its null check as the real one does ("
            + string.Join("; ", refusals.Select(pair => pair.Key + ": " + string.Join(" ", pair.Value.Item2.Take(3)))) + ")");
        var raised = Raised().Matches(procedures).Select(match => match.Groups[1].Value).Distinct().ToList();
        check(raised.Count >= 8 && raised.All(shape.Errors.ContainsKey), "every error the fake raises is a real catalog error number: " + string.Join(", ", raised.Where(number => !shape.Errors.ContainsKey(number))));
        check(!new[] { "SSISDB", "ISServerExec", "xp_", "sp_configure", "RECONFIGURE", "SYNCHRONIZED", "OPENROWSET", "EXTERNAL NAME", "sp_add_trusted_assembly" }
            .Any(word => code.Contains(word, StringComparison.OrdinalIgnoreCase)), "the fake's procedures name no real catalog, process, server setting or assembly");
        var schema = File.ReadAllText(Path.Combine(folder, "schema.sql"));
        var tables = Table().Matches(schema).Select(match => match.Groups[1].Value).ToList();
        var views = View().Matches(schema).Select(match => match.Groups[1].Value).ToList();
        check(schema.StartsWith("-- Generated from manifest.json", StringComparison.Ordinal)
            && tables.Where(name => !name.StartsWith("varia_", StringComparison.Ordinal)).Concat(views).Order(StringComparer.Ordinal).SequenceEqual(shape.Views.Keys.Order(StringComparer.Ordinal))
            && views.SequenceEqual(["event_messages"]) && tables.Where(name => name.StartsWith("varia_", StringComparison.Ordinal)).SequenceEqual(["varia_event_messages"]),
            "schema.sql is generated from the newest manifest entry, one table per catalog view, except catalog.event_messages, a view of operation_messages LEFT JOIN varia_event_messages as the real one is");
    }
}
