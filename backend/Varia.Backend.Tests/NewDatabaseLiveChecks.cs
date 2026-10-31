using System.Globalization;
using System.Text.Json;
using Varia.Backend.Actions;
using Varia.Backend.Protocol;

namespace Varia.Backend.Tests;

/// <summary>Live New Database checks (D1b). Without scratch databases: the describe (model's files and options, the default folders,
/// the server's collation and platform), Script creating nothing, and SQL Server's builder composing exactly
/// <see cref="CreateDatabaseSql.Statement"/> for every hostile database, file, filegroup, file name and path (the dry run creates
/// nothing). With VARIA_TEST_SQL_SCRATCH=1: a real VariaScratch_…_nd database with a quote and a bracket in its names, checked against
/// sys.master_files and sys.filegroups, marked at once and dropped in finally; its options against model's (what CREATE DATABASE does
/// not copy from model); a second OK refused as NAME_IN_USE before any DDL, and Script's warning.</summary>
internal static class NewDatabaseLiveChecks
{
    private static readonly ActionsCatalog Catalog = ActionsCatalog.Current;
    private static string Literal(string value) => "N'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";

    private sealed class Client(SqlService service, string connectionId, JsonSerializerOptions json)
    {
        public async Task<T> Call<T>(string method, object args) => (T)await service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, json), json);
        public Task<ActionDescribeResult> Describe(string dialog, ObjectRefDto target) => Call<ActionDescribeResult>("actions.describe", new ActionDescribeArgs(connectionId, Guid.NewGuid().ToString(), dialog, target));
        private ActionArgs Args(string name, NewDatabaseDesignDto design) => new("createDatabase", connectionId, Guid.NewGuid().ToString(), new ObjectRefDto("database", Name: name), Design: design);
        public Task<ActionScriptResult> Script(string name, NewDatabaseDesignDto design) => Call<ActionScriptResult>("actions.script", Args(name, design));
        public Task<ActionExecuteResult> Create(string name, NewDatabaseDesignDto design) => Call<ActionExecuteResult>("actions.execute", Args(name, design));
    }

    /// <summary>A file name made of a fragment's characters the platform allows, with a quote in it.</summary>
    private static string FileName(string prefix, string fragment, char separator, string extension) =>
        prefix + "'" + new string([.. fragment.Select(c => NewDatabaseValidator.FileNameValid(c.ToString(), separator, 260) ? c : '_')]) + extension;

    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, JsonSerializerOptions json)
    {
        var client = new Client(service, info.Id, json);
        async Task<SqlRun> Sql(string text, string database = "master")
        {
            var id = Guid.NewGuid().ToString();
            try
            {
                var result = (QueryResult)await service.DispatchAsync("query.execute", JsonSerializer.SerializeToElement(
                    new QueryArgs(info.Id, id, database, text, Guid.NewGuid().ToString(), 100_000, 300, StopOnError: true), json), json);
                return new(result.Status, result.Error?.Message, [.. result.ResultSets.Select(set => LiveResultChecks.RowsOf(service.Results, set))]);
            }
            finally { await service.DispatchAsync("query.session.close", JsonSerializer.SerializeToElement(new SessionArgs(id), json), json); }
        }
        var major = int.Parse((await Sql("SELECT CONVERT(int, SERVERPROPERTY('ProductMajorVersion'));")).Scalar!, CultureInfo.InvariantCulture);

        // The describe reads model and the server in master.
        var described = await client.Describe("newDatabase", new ObjectRefDto("server"));
        var model = described.NewDatabase;
        check(described.Error is null && model is { CanCreate: true, DataPath.Length: > 0, LogPath.Length: > 0, ServerCollation.Length: > 0 } && model.MasterLevel >= 130
            && model.Model.Files.Any(file => file.Type == "rows") && model.Model.Files.Any(file => file.Type == "log") && model.Model.Options.ContainsKey("recoveryModel")
            && model.Model.Collations.Contains(model.ServerCollation) && model.Model.Logins.Count > 0,
            "New Database's describe reads model's files and options, the default folders, the server's collation and CREATE DATABASE for a sysadmin (" + described.Error?.Message + ")");
        if (model is null) return;
        var separator = model.Linux ? '/' : '\\';
        var dataFolder = model.DataPath.Length > 1 ? model.DataPath.TrimEnd(separator) : model.DataPath;
        var logFolder = model.LogPath.Length > 1 ? model.LogPath.TrimEnd(separator) : model.LogPath;
        var growth = new GrowthDto(true, "mb", 64);
        NewDatabaseDesignDto Plain(string name, string data, string log) => new(
            [new(name, "rows", growth, data, name + ".mdf", "PRIMARY", 8), new(name + "_log", "log", growth, log, name + "_log.ldf", SizeMb: 8)],
            [new("PRIMARY", "rows", IsDefault: true)], "NONE", [], []);

        // Script runs nothing: the database it scripts does not appear.
        var unused = "VariaNewDatabase_" + Guid.NewGuid().ToString("N");
        var script = await client.Script(unused, Plain(unused, dataFolder, logFolder));
        var appeared = (await Sql("SELECT COUNT(*) FROM sys.databases WHERE name = " + Literal(unused) + ";")).Scalar;
        check(script is { Error: null, Database: "master", Text: { } text } && text.StartsWith("CREATE DATABASE [" + unused + "]", StringComparison.Ordinal) && script.Warnings.Count == 0 && appeared == "0",
            "New Database's Script returns CREATE DATABASE as SSMS lays it out, in master, and creates nothing (" + script.Error?.Message + ")");

        // SQL Server composes exactly the statement for every hostile name, file name and path; the dry run creates nothing.
        var before = ScratchDatabase.Lasting(await Sql(ScratchDatabase.DatabaseNamesSql));
        var mismatches = new List<string>();
        foreach (var fragment in InjectionMatrix.Fragments.Append("]").Append("'").Append(" ").Append("‮").Append("\u0001\t"))
        {
            var hostile = ActionChecks.Long(fragment);
            var folder = dataFolder + separator + "o'k]" + new string([.. fragment.Where(c => c is not ('/' or '\\' or '*' or '?' or '"' or '<' or '>' or '|' or ':') && c >= ' ')]).Trim();
            var design = new NewDatabaseDesignDto(
                [new(hostile, "rows", growth, folder, FileName("p", fragment, separator, ".mdf"), "PRIMARY", 8),
                 new(ActionChecks.Long("g" + fragment), "rows", new(true, "percent", 10, 1_000), folder, FileName("g", fragment, separator, ".ndf"), ActionChecks.Long("f" + fragment), 1),
                 new(ActionChecks.Long("l" + fragment), "log", new(true, "mb", 1, 2_097_152), folder, FileName("l", fragment, separator, ".ldf"), SizeMb: 1),
                 new(ActionChecks.Long("m" + fragment), "log", new(false), folder, FileName("m", fragment, separator, ".ldf"), SizeMb: 1)],
                [new("PRIMARY", "rows"), new(ActionChecks.Long("f" + fragment), "rows", IsDefault: true)], "NONE", [], [], Collation: model.ServerCollation, Ledger: major >= 16 ? true : null);
            var plan = NewDatabaseValidator.Validate(Catalog, hostile, design);
            var built = await service.Actions.DryRunCreateAsync(info.Id, plan, model.Linux, CancellationToken.None);
            if (built.Count != 1 || built[0] != CreateDatabaseSql.Statement(plan, model.Linux)) mismatches.Add(fragment[..1]);
        }
        var after = ScratchDatabase.Lasting(await Sql(ScratchDatabase.DatabaseNamesSql));
        check(mismatches.Count == 0 && after == before, "SQL Server's New Database builder composes exactly CREATE DATABASE for every hostile database, file and filegroup name, file name and path, and the dry run creates nothing: "
            + string.Join(", ", mismatches));

        if (Environment.GetEnvironmentVariable("VARIA_TEST_SQL_SCRATCH") != "1")
        {
            Console.WriteLine("New Database scratch-database checks skipped. Set VARIA_TEST_SQL_SCRATCH=1 to allow creating and dropping a uniquely named database on a disposable development server.");
            return;
        }
        await using var scratch = ScratchDatabase.Bare((text, database) => Sql(text, database));
        var name = scratch.NewDatabase;
        scratch.Adopt(name);
        var created = new NewDatabaseDesignDto(
            [new("nd'1", "rows", growth, dataFolder, "nd'1.mdf", "PRIMARY", 9), new("nd]2", "rows", new(true, "percent", 10, 100), dataFolder, "nd]2.ndf", "FG]'x", 2),
             new("nd_log", "log", new(true, "mb", 3), logFolder, "nd'_log.ldf", SizeMb: 4)],
            [new("PRIMARY", "rows"), new("FG]'x", "rows", IsDefault: true)], "NONE", new() { ["recoveryModel"] = "SIMPLE" }, []);
        // A folder that does not exist is refused before any DDL, never left to CREATE DATABASE.
        var missing = await client.Create(name, Plain(name, dataFolder + separator + "VariaMissing_" + Guid.NewGuid().ToString("N"), logFolder));
        var none = (await Sql("SELECT COUNT(*) FROM sys.databases WHERE name = " + Literal(name) + ";")).Scalar;
        // sys.dm_os_file_exists is SQL Server 2017's: on 2016 CREATE DATABASE itself refuses the folder.
        check((major >= 14 ? missing.Error?.Code == "PATH_NOT_FOUND" : missing.Error is not null) && missing.Steps.All(step => step.Status != "done") && none == "0",
            "New Database refuses a folder the server does not have, before any DDL from SQL Server 2017 (" + missing.Error?.Code + ": " + missing.Error?.Message + ")");
        var result = await client.Create(name, created);
        // Marked at once, so a run that crashes from here on leaves a database the sweep drops.
        var marked = await Sql("EXEC sys.sp_addextendedproperty @name = N'varia.scratch', @value = 1;", name);
        var done = result.Error is null && result.Steps.Count > 1 && result.Steps.All(step => step.Status == "done") && result.Steps[0].Title == "Create the database";
        check(done && marked.Status == "completed", "OK creates the database and sets the default filegroup and recovery model, step by step (" + result.Error?.Message + ": " + string.Join(", ", result.Steps.Select(step => step.Title + " " + step.Status)) + ")");
        var files = await Sql("SELECT f.name, f.physical_name, CONVERT(nvarchar(20), f.size), CONVERT(nvarchar(20), f.growth), CONVERT(nvarchar(1), f.is_percent_growth), CONVERT(nvarchar(20), f.max_size) "
            + "FROM sys.master_files AS f WHERE f.database_id = DB_ID(" + Literal(name) + ") ORDER BY f.file_id;\n"
            + "SELECT g.name, CONVERT(nvarchar(1), g.is_default) FROM sys.filegroups AS g ORDER BY g.data_space_id;\n"
            + "SELECT recovery_model_desc FROM sys.databases WHERE name = DB_NAME();", name);
        string Row(params string[] cells) => string.Join("|", cells);
        var full = (string file) => dataFolder + separator + file;
        var expectedFiles = new[]
        {
            Row("nd'1", full("nd'1.mdf"), (9 * 128).ToString(CultureInfo.InvariantCulture), (64 * 128).ToString(CultureInfo.InvariantCulture), "0", "-1"),
            Row("nd_log", logFolder + separator + "nd'_log.ldf", (4 * 128).ToString(CultureInfo.InvariantCulture), (3 * 128).ToString(CultureInfo.InvariantCulture), "0", "268435456"),
            Row("nd]2", full("nd]2.ndf"), (2 * 128).ToString(CultureInfo.InvariantCulture), "10", "1", (100 * 128).ToString(CultureInfo.InvariantCulture))
        };
        var actualFiles = files.Sets.Count > 0 ? files.Sets[0].Select(row => Row([.. row.Select(cell => cell ?? "")])).ToList() : [];
        var groups = files.Sets.Count > 1 ? files.Sets[1].Select(row => Row([.. row.Select(cell => cell ?? "")])).ToList() : [];
        check(files.Status == "completed" && actualFiles.SequenceEqual(expectedFiles, StringComparer.OrdinalIgnoreCase) && groups.SequenceEqual(["PRIMARY|0", "FG]'x|1"]) && files.Sets[2][0][0] == "SIMPLE",
            "the new database has exactly the files, sizes, growth and maximums the design names (a quote and a bracket in the names and file names, the unlimited log at 2 TB), FG]'x as its default and SIMPLE recovery: "
            + files.Error + " " + string.Join(" / ", actualFiles) + " ; " + string.Join(" / ", groups));

        // What CREATE DATABASE does not copy from model: the document starts from model's options with newDatabaseOverrides over them,
        // so they must be the new database's, whatever model holds on this server.
        var modelOptions = await client.Describe("databaseProperties", new ObjectRefDto("database", Name: "model"));
        var newOptions = await client.Describe("databaseProperties", new ObjectRefDto("database", Name: name));
        var keys = Catalog.DatabaseOptions.Values.Where(option => option.Settable && option.Key is not ("collation" or "containmentType" or "recoveryModel")).Select(option => option.Key);
        string? Baseline(string key) => NewDatabaseOverrides.TryGetValue(key, out var value) ? value : modelOptions.DatabaseProperties?.Options.GetValueOrDefault(key);
        var differ = keys.Where(key => Baseline(key) != newOptions.DatabaseProperties?.Options.GetValueOrDefault(key))
            .Select(key => key + " " + Baseline(key) + "→" + newOptions.DatabaseProperties?.Options.GetValueOrDefault(key))
            .Concat(Catalog.ScopedConfigurations.Values.Where(option => option.Settable).Select(option => option.Key)
                .Where(key => modelOptions.DatabaseProperties?.Scoped.GetValueOrDefault(key) != newOptions.DatabaseProperties?.Scoped.GetValueOrDefault(key))
                .Select(key => key + " " + modelOptions.DatabaseProperties?.Scoped.GetValueOrDefault(key) + "→" + newOptions.DatabaseProperties?.Scoped.GetValueOrDefault(key))).ToList();
        check(modelOptions.Error is null && newOptions.Error is null && newOptions.DatabaseProperties is { } properties && NewDatabaseOverrides.Keys.All(properties.Options.ContainsKey) && differ.Count == 0,
            "a new database takes model's options but those new-database.ts' newDatabaseOverrides sets (" + major + "): " + string.Join(", ", differ));

        // A second OK with the same name is refused before any DDL; Script warns.
        var again = await client.Create(name, created);
        var warned = await client.Script(name, created);
        check(again.Error?.Code == "NAME_IN_USE" && again.Steps.All(step => step.Status != "done") && warned is { Error: null } && warned.Warnings.Count > 0,
            "New Database refuses a name in use before any DDL, and its Script warns about it (" + again.Error?.Code + ")");
    }

    /// <summary>What a new database does not take from model, as new-database.ts' newDatabaseOverrides lists it: CREATE DATABASE enables
    /// Service Broker whatever model says.</summary>
    private static readonly Dictionary<string, string> NewDatabaseOverrides = new(StringComparer.Ordinal) { ["brokerEnabled"] = "true" };
}
