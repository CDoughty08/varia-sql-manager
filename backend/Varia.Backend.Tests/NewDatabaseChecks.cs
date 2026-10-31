using System.Text.Json;
using System.Text.RegularExpressions;
using Varia.Backend.Actions;
using Varia.Backend.Explorer;
using Varia.Backend.Protocol;
using Varia.Backend.Scripting;

namespace Varia.Backend.Tests;

/// <summary>Offline New Database checks (D1b): the request's validation (zod's parity, strict designs), the order CREATE DATABASE
/// lists files in, the statement and script goldens (the same statement but for white space), MAXSIZE for a log at its ceiling, the
/// server's rules, the filegroup ALTER templates, and the builder's lint (form 5) with the mutations it must catch.</summary>
internal static class NewDatabaseChecks
{
    private static readonly ActionsCatalog Catalog = ActionsCatalog.Current;
    private static readonly GrowthDto Mb64 = new(true, "mb", 64);
    private static readonly GrowthDto None = new(false);

    /// <summary>The design New Database starts with for Sales on a Windows server.</summary>
    internal static NewDatabaseDesignDto Design(params NewDatabaseFileDto[] extra) => new(
        [new("Sales", "rows", Mb64, "C:\\Data", "Sales.mdf", "PRIMARY", 8), new("Sales_log", "log", Mb64, "C:\\Data", "Sales_log.ldf", SizeMb: 8), .. extra],
        [new("PRIMARY", "rows", IsDefault: true)], "NONE", [], []);

    public static void Run(Action<bool, string> check)
    {
        Validation(check);
        Goldens(check);
        ServerRules(check);
        Filegroups(check);
        Lint(check);
    }

    private static void Validation(Action<bool, string> check)
    {
        using var service = new ActionService(new NoHost());
        ActionArgs Create(NewDatabaseDesignDto? design, string name = "Sales", ObjectRefDto? target = null) =>
            new("createDatabase", Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), target ?? new ObjectRefDto("database", Name: name), Design: design);
        string Verdict(ActionArgs args)
        {
            try { service.Validate(args); return "accepted"; }
            catch (RequestException error) { return error.Code; }
        }
        var good = Design();
        var many = Enumerable.Range(0, 256).Select(index => new NewDatabaseFileDto("f" + index, "rows", Mb64, "C:\\Data", "f" + index + ".ndf", "PRIMARY", 8)).ToArray();
        var groups = Enumerable.Range(0, 256).Select(index => new NewDatabaseFilegroupDto("g" + index, "rows")).Prepend(new("PRIMARY", "rows")).ToList();
        var invalid = new (string Name, ActionArgs Args)[]
        {
            ("no design", Create(null)), ("a system database's name", Create(good, "Model")), ("an empty name", Create(good, "")), ("a 129-unit name", Create(good, new string('d', 129))),
            ("a database member", Create(good, target: new ObjectRefDto("database", "master", Name: "Sales"))), ("a schema member", Create(good, target: new ObjectRefDto("database", Schema: "dbo", Name: "Sales"))),
            ("a table target", Create(good, target: new ObjectRefDto("table", "master", "dbo", "T"))), ("a new name", Create(good) with { NewName = "x" }), ("delete options", Create(good) with { CloseConnections = false }),
            ("no log file", Create(good with { Files = [good.Files[0]] })), ("a log first", Create(good with { Files = [good.Files[1], good.Files[0]] })),
            ("two files named alike", Create(Design(good.Files[1] with { Name = "SALES_LOG", FileName = "x.ldf" }))),
            ("two files at one path", Create(Design(good.Files[1] with { Name = "other", FileName = "SALES_LOG.LDF" }))),
            ("a log in a filegroup", Create(Design(good.Files[1] with { Name = "l2", FileName = "l2.ldf", Filegroup = "PRIMARY" }))),
            ("a missing filegroup", Create(Design(good.Files[0] with { Name = "a", FileName = "a.ndf", Filegroup = "A" }))),
            ("an empty filegroup", Create(good with { Filegroups = [.. good.Filegroups, new("A", "rows")] })),
            ("PRIMARY not first", Create(good with { Filegroups = [new("A", "rows"), .. good.Filegroups] })),
            ("a read-only PRIMARY", Create(good with { Filegroups = [new("PRIMARY", "rows", ReadOnly: true)] })),
            ("two rows defaults", Create(Design(good.Files[0] with { Name = "a", FileName = "a.ndf", Filegroup = "A" }) with { Filegroups = [new("PRIMARY", "rows", IsDefault: true), new("A", "rows", IsDefault: true)] })),
            ("257 files", Create(Design(many))), ("257 filegroups", Create(good with { Filegroups = groups })),
            ("a data file over 2147483647 pages", Create(good with { Files = [good.Files[0] with { SizeMb = 16_777_216 }, good.Files[1]] })),
            ("a log file over 2 TB", Create(good with { Files = [good.Files[0], good.Files[1] with { SizeMb = 2_097_153 }] })),
            ("a growth of 0 MB", Create(good with { Files = [good.Files[0] with { Growth = new(true, "mb", 0) }, good.Files[1]] })),
            ("a growth of 101 percent", Create(good with { Files = [good.Files[0] with { Growth = new(true, "percent", 101) }, good.Files[1]] })),
            ("a maximum under the size", Create(good with { Files = [good.Files[0] with { Growth = new(true, "mb", 1, 4) }, good.Files[1]] })),
            ("a growth over the maximum", Create(good with { Files = [good.Files[0] with { Growth = new(true, "mb", 100, 50) }, good.Files[1]] })),
            ("a data maximum over 2147483647 pages", Create(good with { Files = [good.Files[0] with { Growth = new(true, "mb", 64, 16_777_216) }, good.Files[1]] })),
            ("growth members without growth", Create(good with { Files = [good.Files[0] with { Growth = new(false, "mb", 1) }, good.Files[1]] })),
            ("a container with a size", Create(Design(new NewDatabaseFileDto("s", "filestream", None, "C:\\Data", "s", "FS", 8)) with { Filegroups = [.. good.Filegroups, new("FS", "filestream")] })),
            ("a container that grows", Create(Design(new NewDatabaseFileDto("s", "filestream", Mb64, "C:\\Data", "s", "FS")) with { Filegroups = [.. good.Filegroups, new("FS", "filestream")] })),
            ("a relative path", Create(good with { Files = [good.Files[0] with { Path = "Data" }, good.Files[1]] })),
            ("a colon in a Windows file name", Create(good with { Files = [good.Files[0] with { FileName = "a:b.mdf" }, good.Files[1]] })),
            ("a device name on Windows", Create(good with { Files = [good.Files[0] with { FileName = "CON.mdf" }, good.Files[1]] })),
            ("a trailing dot on Windows", Create(good with { Files = [good.Files[0] with { FileName = "a." }, good.Files[1]] })),
            ("a slash in a Linux file name", Create(good with { Files = [good.Files[0] with { Path = "/var/opt", FileName = "a/b.mdf" }, good.Files[1]] })),
            ("a backslash in a Linux file name", Create(good with { Files = [good.Files[0] with { Path = "/var/opt", FileName = "a\\b.mdf" }, good.Files[1] with { Path = "/var/opt" }] })),
            ("collation as an option", Create(good with { Options = new() { ["collation"] = "Latin1_General_BIN2" } })),
            ("containment as an option", Create(good with { Options = new() { ["containmentType"] = "PARTIAL" } })),
            ("an unknown option", Create(good with { Options = new() { ["bogus"] = "true" } })), ("a fact option", Create(good with { Options = new() { ["isLedgerDatabase"] = "true" } })),
            ("a bad token", Create(good with { Options = new() { ["recoveryModel"] = "FULL;" } })), ("a bad scoped token", Create(good with { Scoped = new() { ["maxDop"] = "-1" } })),
            ("incremental without auto create", Create(good with { Options = new() { ["autoCreateStatistics"] = "false", ["autoCreateIncrementalStatistics"] = "true" } })),
            ("an owner after read-only", Create(good with { Owner = "sa", Options = new() { ["readOnly"] = "true" } })),
            ("a bad collation name", Create(good with { Collation = "Latin1 General" })), ("a bad containment", Create(good with { Containment = "FULL" }))
        };
        // JSON cannot carry half a surrogate pair (STJ writes U+FFFD), so the file name rule is checked directly.
        check(!NewDatabaseValidator.FileNameValid("a\uD800.mdf", '\\', 260) && !NewDatabaseValidator.FileNameValid("a\uDC00", '/', 260) && NewDatabaseValidator.FileNameValid("a😀.mdf", '\\', 260),
            "a file name holding half a surrogate pair is refused, a whole pair accepted");
        var verdicts = invalid.Select(item => (item.Name, Verdict: Verdict(item.Args))).ToList();
        var accepted = new[] { Create(good), Create(good with { Owner = "AppUser", Collation = "Latin1_General_BIN2", Containment = "PARTIAL", Ledger = true, Options = new() { ["recoveryModel"] = "SIMPLE" }, Scoped = new() { ["maxDop"] = "4" } }),
            Create(good with { Files = [good.Files[0] with { Path = "/var/opt/mssql/data", FileName = "a:b.mdf" }, good.Files[1] with { Path = "/var/opt/mssql/data" }] }), Create(Design(many[..254])),
            Create(good with { Files = [.. Ceilings("Sales").Files.Select(file => (NewDatabaseFileDto)new(file.Name, file.Type, file.Growth, file.Path, file.FileName, file.Filegroup, file.SizeMb))] }) };
        check(verdicts.All(item => item.Verdict == "INVALID_PARAMS") && accepted.All(args => Verdict(args) == "accepted"),
            "New Database's validation accepts what zod accepts (a Linux file name may hold a colon) and refuses the rest, as INVALID_PARAMS: "
            + string.Join(", ", verdicts.Where(item => item.Verdict != "INVALID_PARAMS").Select(item => item.Name + " " + item.Verdict)) + string.Join(", ", accepted.Select(Verdict).Where(verdict => verdict != "accepted")));

        // A design is read strictly as the action's own: a member the TypeScript design does not have is refused.
        var json = JsonSerializer.SerializeToElement(good, ActionDesign.Strict).ToString();
        var extra = new ActionDesign(JsonDocument.Parse(json[..^1] + ",\"filestream\":true}").RootElement);
        var designer = new ActionDesign(JsonDocument.Parse("{\"schema\":\"dbo\",\"name\":\"T\",\"columns\":[],\"primaryKey\":[]}").RootElement);
        check(Verdict(Create(null) with { Design = extra }) == "INVALID_PARAMS" && Verdict(Create(null) with { Design = designer }) == "INVALID_PARAMS",
            "a New Database design with a member it does not have, or a table design, is INVALID_PARAMS");
        var script = Create(good) with { Secrets = new LoginSecretsDto("x") };
        string scripted;
        try { service.Validate(script, script: true); scripted = "accepted"; } catch (RequestException error) { scripted = error.Code; }
        check(scripted == "INVALID_PARAMS", "New Database's Script never carries secrets");

        // The describe reads the server: its target is the server, never a database.
        string Describe(ObjectRefDto target)
        {
            try { service.Validate(new ActionDescribeArgs(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "newDatabase", target)); return "accepted"; }
            catch (RequestException error) { return error.Code; }
        }
        check(Describe(new ObjectRefDto("server")) == "accepted" && Describe(new ObjectRefDto("database", Name: "master")) == "INVALID_PARAMS",
            "New Database's describe takes the server as its target and refuses a database");

        // CREATE DATABASE lists PRIMARY's files, then each filegroup's in filegroup order, then the logs, keeping their own order.
        var ordered = NewDatabaseValidator.Validate(Catalog, "Sales", new([
            good.Files[0], good.Files[1], new("b1", "rows", Mb64, "C:\\Data", "b1.ndf", "B", 1), new("a1", "rows", Mb64, "C:\\Data", "a1.ndf", "A", 1),
            new("p2", "rows", Mb64, "C:\\Data", "p2.ndf", "PRIMARY", 1), new("l2", "log", Mb64, "C:\\Data", "l2.ldf", SizeMb: 1)],
            [new("PRIMARY", "rows"), new("A", "rows", IsDefault: true), new("B", "rows")], "NONE", [], []));
        check(string.Join(",", ordered.Files.Select(file => file.Name)) == "Sales,p2,a1,b1,Sales_log,l2", "New Database orders the files as CREATE DATABASE lists them: PRIMARY's, each filegroup's, then the logs");
    }

    /// <summary>A design with every kind of clause: two PRIMARY files, a rows filegroup made the default after CREATE, a FILESTREAM
    /// default made in CREATE, two logs (one limited to the log ceiling), a collation and ledger.</summary>
    internal static NewDatabasePlan Full(string name = "Sales") => NewDatabaseValidator.Validate(Catalog, name, new([
        new("Sales", "rows", Mb64, "C:\\Data", "Sales.mdf", "PRIMARY", 8),
        new("Sales2", "rows", new(true, "percent", 10, 100), "C:\\Data\\", "Sales2.ndf", "PRIMARY", 8),
        new("A1", "rows", None, "C:/Data", "A1.ndf", "A", 1),
        new("Stream", "filestream", None, "C:\\Data", "Stream", "FS"),
        new("Sales_log", "log", Mb64, "C:\\Logs", "Sales_log.ldf", SizeMb: 8),
        new("Sales_log2", "log", new(true, "mb", 1, 2_097_152), "C:\\Logs", "Sales_log2.ldf", SizeMb: 1)],
        [new("PRIMARY", "rows"), new("A", "rows", IsDefault: true), new("FS", "filestream", IsDefault: true)], "NONE", [], [], Collation: "Latin1_General_BIN2", Ledger: true));

    /// <summary>Files at the catalogue's ceilings: a data file of 2147483647 pages that grows by 2 TB, one just under 2 TB (the last
    /// size SSMS's KB form can write) and a 2 TB log.</summary>
    internal static NewDatabasePlan Ceilings(string name, string folder = "C:\\Data") => NewDatabaseValidator.Validate(Catalog, name, new([
        new(name, "rows", new(true, "mb", 2_097_152, 16_777_215), folder, "c.mdf", "PRIMARY", 16_777_215),
        new(name + "_2", "rows", new(true, "mb", 2_097_151, 2_097_151), folder, "c2.ndf", "PRIMARY", 2_097_151),
        new(name + "_log", "log", new(true, "mb", 2_097_152, 2_097_152), folder, "c.ldf", SizeMb: 2_097_152)],
        [new("PRIMARY", "rows", IsDefault: true)], "NONE", [], []));

    private static void Goldens(Action<bool, string> check)
    {
        var plan = Full();
        var statement = CreateDatabaseSql.Statement(plan, linux: false);
        const string expected = "CREATE DATABASE [Sales] CONTAINMENT = NONE ON PRIMARY "
            + "( NAME = N'Sales', FILENAME = N'C:\\Data\\Sales.mdf', SIZE = 8192KB, MAXSIZE = UNLIMITED, FILEGROWTH = 65536KB ), "
            + "( NAME = N'Sales2', FILENAME = N'C:\\Data\\Sales2.ndf', SIZE = 8192KB, MAXSIZE = 102400KB, FILEGROWTH = 10% ), "
            + "FILEGROUP [A] ( NAME = N'A1', FILENAME = N'C:\\Data\\A1.ndf', SIZE = 1024KB, FILEGROWTH = 0 ), "
            + "FILEGROUP [FS] CONTAINS FILESTREAM DEFAULT ( NAME = N'Stream', FILENAME = N'C:\\Data\\Stream' ) "
            + "LOG ON ( NAME = N'Sales_log', FILENAME = N'C:\\Logs\\Sales_log.ldf', SIZE = 8192KB, MAXSIZE = 2048GB, FILEGROWTH = 65536KB ), "
            + "( NAME = N'Sales_log2', FILENAME = N'C:\\Logs\\Sales_log2.ldf', SIZE = 1024KB, MAXSIZE = 2048GB, FILEGROWTH = 1024KB ) "
            + "COLLATE Latin1_General_BIN2 WITH LEDGER = ON";
        check(statement == expected, "New Database's CREATE DATABASE has every clause as SSMS writes it (sizes in KB, an unlimited or 2 TB log as 2048GB, FILEGROWTH = 0 without autogrowth, a FILESTREAM default in CREATE): " + statement);
        var nl = ScriptFormatter.NewLine;
        var script = CreateDatabaseSql.Script(plan, linux: false);
        var lines = script.Split(nl);
        check(lines[0] == "CREATE DATABASE [Sales]" && lines[1] == " CONTAINMENT = NONE" && lines[2] == " ON PRIMARY" && lines[3].StartsWith("( NAME = N'Sales',", StringComparison.Ordinal)
            && lines.Contains(" FILEGROUP [FS] CONTAINS FILESTREAM DEFAULT") && lines.Contains(" LOG ON") && lines.Contains(" WITH LEDGER = ON") && script.EndsWith(nl + "GO" + nl, StringComparison.Ordinal)
            && Regex.Replace(script[..^(nl.Length + 2 + nl.Length)], @"\s+", " ") == statement,
            "New Database's script lays CREATE DATABASE out as SSMS does, a clause a line, then GO, and differs from what OK runs only in white space");
        // A database name and file names with quotes and brackets: brackets doubled in the name, quotes doubled in the literals.
        var hostile = NewDatabaseValidator.Validate(Catalog, "a]'b", Design() with
        {
            Files = [new("x'y", "rows", Mb64, "/var/opt/o'k", "x'y.mdf", "PRIMARY", 1), new("l]", "log", Mb64, "/var/opt/o'k", "l].ldf", SizeMb: 1)]
        });
        check(CreateDatabaseSql.Statement(hostile, linux: true).StartsWith("CREATE DATABASE [a]]'b] CONTAINMENT = NONE ON PRIMARY ( NAME = N'x''y', FILENAME = N'/var/opt/o''k/x''y.mdf', SIZE = 1024KB", StringComparison.Ordinal),
            "New Database doubles a ] in the database's name and a quote in a file's name and path");
        // The JSON the builder reads carries sizes in KB and the kinds, never statement text.
        using var design = JsonDocument.Parse(CreateDatabaseSql.DesignJson(plan, linux: false));
        var files = design.RootElement.GetProperty("files").EnumerateArray().ToList();
        check(files.Select(file => file.GetProperty("lead").GetInt32()).SequenceEqual([1, 0, 2, 2, 3, 0]) && files[5].GetProperty("maxKind").GetInt32() == 3 && files[5].GetProperty("max").ValueKind == JsonValueKind.Null
            && files[1].GetProperty("max").GetInt64() == 102_400 && files[3].GetProperty("size").ValueKind == JsonValueKind.Null && files[3].GetProperty("default").GetBoolean()
            && !files[2].GetProperty("default").GetBoolean() && design.RootElement.GetProperty("collated").GetBoolean() && !design.RootElement.ToString().Contains("CREATE", StringComparison.Ordinal),
            "New Database's design parameter carries each file's lead, kinds and sizes in KB (a log at 2 TB as 2048GB), and a rows default is not CREATE's");
        // SQL Server reads a size's number as an int: 2147483648KB is a syntax error, so from 2 TB on a size is written in MB.
        var ceilings = Ceilings("Big");
        check(CreateDatabaseSql.Statement(ceilings, linux: false) == "CREATE DATABASE [Big] CONTAINMENT = NONE ON PRIMARY "
            + "( NAME = N'Big', FILENAME = N'C:\\Data\\c.mdf', SIZE = 16777215MB, MAXSIZE = 16777215MB, FILEGROWTH = 2097152MB ), "
            + "( NAME = N'Big_2', FILENAME = N'C:\\Data\\c2.ndf', SIZE = 2147482624KB, MAXSIZE = 2147482624KB, FILEGROWTH = 2147482624KB ) "
            + "LOG ON ( NAME = N'Big_log', FILENAME = N'C:\\Data\\c.ldf', SIZE = 2097152MB, MAXSIZE = 2048GB, FILEGROWTH = 2097152MB )",
            "New Database writes a size in KB while its number fits an int and in MB from 2 TB on: " + CreateDatabaseSql.Statement(ceilings, linux: false));
        using var big = JsonDocument.Parse(CreateDatabaseSql.DesignJson(ceilings, linux: false));
        var bigFiles = big.RootElement.GetProperty("files").EnumerateArray().ToList();
        long Number(JsonElement file, string name) => file.GetProperty(name).GetInt64();
        check(Number(bigFiles[0], "size") == 16_777_215 && Number(bigFiles[0], "sizeUnit") == 1 && Number(bigFiles[0], "max") == 16_777_215 && Number(bigFiles[0], "maxUnit") == 1
            && Number(bigFiles[0], "growth") == 2_097_152 && Number(bigFiles[0], "growthUnit") == 1 && Number(bigFiles[1], "size") == 2_147_482_624 && Number(bigFiles[1], "sizeUnit") == 0
            && Number(bigFiles[1], "growthUnit") == 0 && bigFiles[2].GetProperty("max").ValueKind == JsonValueKind.Null && bigFiles[2].GetProperty("maxUnit").ValueKind == JsonValueKind.Null
            && files[1].GetProperty("growthUnit").ValueKind == JsonValueKind.Null && Number(files[0], "growthUnit") == 0,
            "New Database's design parameter gives each size its unit as a kind (KB or MB), never as text");
    }

    private static void ServerRules(Action<bool, string> check)
    {
        var windows = new NewDatabaseFacts(16, false, 2, false);
        var linux = new NewDatabaseFacts(16, true, 0, false);
        var good = NewDatabaseValidator.Validate(Catalog, "Sales", Design());
        var colon = NewDatabaseValidator.Validate(Catalog, "Sales", Design() with { Files = [Design().Files[0] with { Path = "/var/opt", FileName = "a:b.mdf" }, Design().Files[1] with { Path = "/var/opt" }] });
        var full = Full();
        string? Code(NewDatabasePlan plan, NewDatabaseFacts facts) => NewDatabaseValidator.ServerProblem(Catalog, plan, facts)?.Code;
        check(Code(good, windows) is null && Code(good, linux) == "PATH_NOT_FOUND" && Code(colon, windows) == "PATH_NOT_FOUND" && Code(colon, linux) is null
            && Code(full, windows with { FilestreamLevel = 0 }) == "NOT_SUPPORTED" && Code(full, windows with { Level = 15 }) == "NOT_SUPPORTED" && Code(full, windows) is null
            && Code(good with { Containment = "PARTIAL" }, windows) == "NOT_SUPPORTED" && Code(good with { Containment = "PARTIAL" }, windows with { ContainedAuthentication = true }) is null,
            "New Database's preflight refuses a path of the other platform, FILESTREAM where it is off, ledger before 2022 and Partial without contained authentication");
        // FILESTREAM on Linux: the folder is a Linux one, so only the platform refuses it.
        var stream = NewDatabaseValidator.Validate(Catalog, "Sales", Design(new NewDatabaseFileDto("s", "filestream", None, "/var/opt", "s", "FS")) with
        {
            Files = [Design().Files[0] with { Path = "/var/opt" }, Design().Files[1] with { Path = "/var/opt" }, new("s", "filestream", None, "/var/opt", "s", "FS")],
            Filegroups = [new("PRIMARY", "rows", IsDefault: true), new("FS", "filestream")]
        });
        check(NewDatabaseValidator.ServerProblem(Catalog, stream, linux) is ("NOT_SUPPORTED", "SQL Server on Linux has no FILESTREAM."), "New Database refuses FILESTREAM on Linux");
    }

    private static void Filegroups(Action<bool, string> check)
    {
        var plan = Full();
        var changes = plan.FilegroupChanges().ToList();
        var statements = changes.Select(change => DatabaseAlter.Statement(Catalog, new AlterStatement(change.Template, "Sales", "filegroup", Name: change.Filegroup))).ToList();
        var readOnly = DatabaseAlter.Statement(Catalog, new AlterStatement(AlterTemplate.FilegroupReadOnly, "a]b", "filegroup", Name: "g]"));
        var autogrow = DatabaseAlter.Statement(Catalog, new AlterStatement(AlterTemplate.FilegroupAutogrowAll, "Sales", "filegroup", Name: "A"));
        check(changes.Count == 1 && statements.SequenceEqual(["ALTER DATABASE [Sales] MODIFY FILEGROUP [A] DEFAULT"]) && readOnly == "ALTER DATABASE [a]]b] MODIFY FILEGROUP [g]]] READ_ONLY"
            && autogrow == "ALTER DATABASE [Sales] MODIFY FILEGROUP [A] AUTOGROW_ALL_FILES",
            "New Database sets a rows default, Read-Only and Autogrow All Files with ALTER DATABASE … MODIFY FILEGROUP after CREATE, never a FILESTREAM default: " + string.Join(" | ", statements));
    }

    /// <summary>The builder's quoted-literal form of a file's logical name.</summary>
    private const string QuotedName = "N'N''' + REPLACE(j.[name] COLLATE Latin1_General_BIN2, N'''', N'''''') + N''''";

    private static void Lint(Action<bool, string> check)
    {
        var results = CreateDatabaseSql.LintAll().ToList();
        var failing = results.Where(result => result.Problems.Count > 0).Select(result => result.Name + ": " + string.Join("; ", result.Problems)).ToList();
        check(failing.Count == 0 && results.Count == 2 + (ExplorerCatalog.MaxBand - ExplorerCatalog.MinBand + 1),
            "New Database's builder (run and dry run) and facts pass their lint: " + string.Join(" | ", failing.Take(3)));
        var good = CreateDatabaseSql.Builder();
        var dry = CreateDatabaseSql.Builder(dryRun: true);
        string Swap(string text, string from, string to) => text.Replace(from, to, StringComparison.Ordinal);
        var mutations = new (string Name, string Text, bool Dry)[]
        {
            ("STRING_AGG", Swap(good, "DECLARE @stmt nvarchar(max)", "SELECT @body = STRING_AGG(f.spec, N'') FROM @f AS f;\nDECLARE @stmt nvarchar(max)"), false),
            ("a second EXEC", Swap(good, "SELECT @stmt AS stmt", "") + "\nEXEC (@stmt);", false),
            ("EXEC in a dry run", dry + "\n" + CreateDatabaseSql.Execution, true),
            ("sp_executesql by name", Swap(good, CreateDatabaseSql.Execution, "EXEC master.sys.sp_executesql @stmt;"), false),
            ("no quoting guard", Swap(good, ActionSql.Guard, ""), false),
            ("a raw filegroup", Swap(good, "QUOTENAME(j.[group])", "j.[group]"), false),
            ("a raw database name", Swap(good, "@name = QUOTENAME(d.[name])", "@name = d.[name]"), false),
            ("a quoted text without its collation", Swap(good, "REPLACE(j.[file] COLLATE Latin1_General_BIN2,", "REPLACE(j.[file],"), false),
            ("a file name concatenated", Swap(good, "N', FILENAME = ' + ", "N', FILENAME = ' + j.[file] + "), false),
            ("the collation from the design", Swap(good, "N' COLLATE ' + c.name", "N' COLLATE ' + d.collation"), false),
            ("@db outside QUOTENAME", Swap(good, "QUOTENAME(@db) + N'.sys.sp_executesql'", "@db + N'.sys.sp_executesql'"), false),
            ("@design concatenated", Swap(good, "N'CREATE DATABASE ' + @name", "N'CREATE DATABASE ' + @design"), false),
            ("@files concatenated", Swap(good, "+ @body +", "+ @files +"), false),
            ("a JSON element concatenated", Swap(good, "OPENJSON(a.value)", "OPENJSON(N'[]') + a.value"), false),
            ("an undeclared variable", Swap(good, "+ @body +", "+ @other +"), false),
            ("a quote in a literal", Swap(good, "N' DEFAULT'", "N' DEFAULT'''"), false),
            ("a comment literal", Swap(good, "N' DEFAULT'", "N' DEFAULT --'"), false),
            ("a bracket literal", Swap(good, "N' DEFAULT'", "N' [DEFAULT]'"), false),
            ("a format hole", Swap(good, "N'CREATE DATABASE '", "N'CREATE DATABASE {0}'"), false),
            // Design text of another type, or read through a variable, is still design text.
            ("a raw file name as nvarchar(128)", Swap(Swap(good, "[default] bit, [name] nvarchar(max)", "[default] bit, [name] nvarchar(128)"), QuotedName, "j.[name]"), false),
            ("a raw file name as sysname", Swap(Swap(good, "[default] bit, [name] nvarchar(max)", "[default] bit, [name] sysname"), QuotedName, "j.[name]"), false),
            ("a raw database name as varchar(max)", Swap(Swap(good, "([name] nvarchar(max), containment int", "([name] varchar(max), containment int"), "@name = QUOTENAME(d.[name])", "@name = d.[name]"), false),
            ("a variable read from a short text column", Swap(Swap(good, "DECLARE @stmt nvarchar(max)",
                "DECLARE @raw nvarchar(max) = (SELECT TOP (1) x.[name] FROM OPENJSON(@files) WITH ([name] nvarchar(128)) AS x ORDER BY x.[name]);\nDECLARE @stmt nvarchar(max)"),
                "N'CREATE DATABASE ' + @name", "N'CREATE DATABASE ' + @raw"), false),
            ("a design column without its alias", Swap(good, "@name = QUOTENAME(d.[name])", "@name = [name]"), false),
            ("a JSON column outside an array", Swap(good, "@collate = CASE d.collated", "@collate = d.files + CASE d.collated"), false),
            ("an OPENJSON with a long alias", Swap(good, "AS j;", "AS jj;"), false),
            ("an index outside CONVERT", Swap(good, "CONVERT(int, a.[key])", "a.[key]"), false),
            ("a whole row", Swap(good, "IF NOT EXISTS (SELECT 1 FROM @f)", "IF NOT EXISTS (SELECT * FROM OPENJSON(@files) WITH ([name] nvarchar(max)) AS z)"), false)
        };
        var missed = mutations.Where(mutation => mutation.Text == (mutation.Dry ? dry : good) || CreateDatabaseSql.Lint(mutation.Text, CreateDatabaseSql.Messages, mutation.Dry).Count == 0).Select(mutation => mutation.Name).ToList();
        check(missed.Count == 0, "New Database's builder lint catches every mutation that would let design text reach the statement or run text another way: " + string.Join(", ", missed));
        check(!good.Contains("EXEC (", StringComparison.Ordinal) && good.Split("EXEC ").Length == 2 && !dry.Contains("EXEC", StringComparison.Ordinal),
            "New Database's builder runs its statement only through QUOTENAME(@db)'s sp_executesql, and its dry run runs nothing");
    }

    private sealed class NoHost : IActionHost
    {
        public ServerProfile Profile(string connectionId) => throw new RequestException("NOT_CONNECTED", "Not connected.");
        public Microsoft.Data.SqlClient.SqlConnection Connection(string connectionId) => throw new InvalidOperationException();
        public Task OpenAsync(Microsoft.Data.SqlClient.SqlConnection connection, CancellationToken token) => Task.CompletedTask;
        public bool ClearPoolsFor(string connectionId, string database) => false;
        public bool FreeDatabase(string connectionId, string database) => false;
        public IReadOnlySet<int> PoolSessions(string connectionId) => new HashSet<int>();
        public void DatabaseChanged(string connectionId, string database, string? newName) { }
    }
}
