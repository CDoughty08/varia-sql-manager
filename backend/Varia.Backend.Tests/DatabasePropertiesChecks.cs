using Varia.Backend.Actions;
using Varia.Backend.Explorer;
using Varia.Backend.Protocol;

namespace Varia.Backend.Tests;

/// <summary>Offline Database Properties checks: the version 2 catalogue, validation parity with zod, SSMS's script text for
/// every statement form (SMO's double spaces included), the plan's order and refusals, the lint over every batch the
/// catalogue can plan with mutations it must catch, and the describe's conversions.</summary>
internal static class DatabasePropertiesChecks
{
    private static readonly ActionsCatalog Catalog = ActionsCatalog.Current;
    private static readonly string NL = Environment.NewLine;
    private static readonly DatabaseAlter.Facts Facts2022 = new(16, 160, AutoCreateStatistics: true);

    public static void Run(Action<bool, string> check)
    {
        CatalogChecks(check);
        Validation(check);
        Scripts(check);
        Plans(check);
        Lint(check);
        Describe(check);
    }

    private static void CatalogChecks(Action<bool, string> check)
    {
        var options = Catalog.DatabaseOptions.Values.ToList();
        var scoped = Catalog.ScopedConfigurations.Values.ToList();
        var orders = options.Concat(scoped).Select(option => option.SmoOrder).ToList();
        check(ActionsCatalog.Version == 2 && options.Count == 46 && scoped.Count == 8 && orders.Distinct().Count() == orders.Count && Catalog.Dialogs.Keys.SequenceEqual(["deleteObject", "databaseProperties"])
            && Catalog.ActionOf("databaseProperties") == "properties" && Catalog.ActionOf("deleteObject") == "delete" && Catalog.ServesSystemObjects("properties") && !Catalog.ServesSystemObjects("delete")
            && Catalog.CompatibilityLevels.SequenceEqual([100, 110, 120, 130, 140, 150, 160, 170]) && Catalog.OwnerNotOn.SequenceEqual(["master", "model", "tempdb"]),
            "the embedded actions catalogue is version 2 with Database Properties' dialog, its 46 options and 8 scoped configurations in one strict SMO order (" + options.Count + ", " + scoped.Count + ")");
        check(options.Concat(scoped).Where(option => option.Settable).All(option => option.Sql is not null && (option.Sql.Kind != "set" || option.Sql.Seconds == true || option.Sql.Tokens!.Keys.ToHashSet().SetEquals(option.Tokens!)))
            && options.All(option => DatabaseProperties.Token(option.Key, true) is not null),
            "every settable option says how it is written, a SET option for each of its tokens, and the describe reads every option");
        check(Catalog.Limit("scriptChars") == 1_000_000 && Catalog.Limit("statements") == 512 && Catalog.Limit("files") == 1_024 && Catalog.Limit("collations") == 8_192,
            "the script cap equals main's 1,000,000-character query limit, and the describe's lists are bounded");
    }

    private static ActionArgs Properties(DatabaseChangesDto? changes, ObjectRefDto? target = null, bool close = false) =>
        new("properties", Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), target ?? new ObjectRefDto("database", Name: "AppData"), CloseConnections: close, Changes: changes);
    private static DatabaseChangesDto Options(params (string Key, string Token)[] values) => new(Options: values.ToDictionary(item => item.Key, item => item.Token));

    private static void Validation(Action<bool, string> check)
    {
        using var service = new ActionService(new NoHost());
        string Refused(ActionArgs args)
        {
            try { service.Validate(args); return "accepted"; }
            catch (RequestException error) { return error.Code; }
        }
        var invalid = new (string Name, ActionArgs Args)[]
        {
            ("no changes", Properties(new DatabaseChangesDto())), ("changes missing", Properties(null)), ("an unknown option", Properties(Options(("autoCloseX", "true")))),
            ("a read-only option", Properties(Options(("trustworthy", "true")))), ("a wrong token", Properties(Options(("recoveryModel", "PARTIAL")))),
            ("MAXDOP 32,768", Properties(new(Scoped: new() { ["maxDop"] = "32768" }))), ("a padded number", Properties(new(Scoped: new() { ["maxDop"] = " 4" }))),
            ("a leading zero", Properties(new(Scoped: new() { ["maxDop"] = "04" }))), ("a negative recovery time", Properties(Options(("targetRecoveryTime", "-1")))),
            ("a collation with a quote", Properties(Options(("collation", "Latin1'")))), ("a 129-unit owner", Properties(new(Owner: new string('x', 129)))),
            ("an owner with U+0000", Properties(new(Owner: "a\0b"))), ("an empty owner", Properties(new(Owner: ""))),
            ("closeConnections without an exclusive change", Properties(Options(("autoClose", "true")), close: true)),
            ("a table target", Properties(Options(("autoClose", "true")), new ObjectRefDto("table", "AppData", "dbo", "Orders"))),
            ("changes on a rename", new ActionArgs("rename", Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), new ObjectRefDto("database", Name: "AppData"), "B", Changes: Options(("autoClose", "true")))),
            ("changes on a delete", new ActionArgs("delete", Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), new ObjectRefDto("database", Name: "AppData"), null, false, false, Options(("autoClose", "true")))),
            ("a new name on properties", Properties(Options(("autoClose", "true"))) with { NewName = "x" }), ("delete history on properties", Properties(Options(("autoClose", "true"))) with { DeleteHistory = false }),
        };
        var accepted = invalid.Where(item => Refused(item.Args) != "INVALID_PARAMS").Select(item => item.Name).ToList();
        check(accepted.Count == 0, "Validate refuses what zod refuses for Database Properties: " + string.Join(", ", accepted));
        check(Refused(Properties(Options(("autoClose", "true")), new ObjectRefDto("database", Name: "master"))) == "accepted"
            && Refused(Properties(new(Owner: ActionChecks.Long("q]'); DROP TABLE dbo.Canary; --")))) == "accepted" && Refused(Properties(new(Owner: " "))) == "accepted"
            && Refused(Properties(Options(("readOnly", "true")), close: true)) == "accepted" && Refused(Properties(new(Scoped: new() { ["maxDopForSecondary"] = "PRIMARY" }))) == "accepted"
            && Refused(Properties(Options(("collation", "Latin1_General_100_CI_AS_SC_UTF8")))) == "accepted" && Refused(Properties(Options(("targetRecoveryTime", "2147483647")))) == "accepted",
            "Properties accepts system databases, hostile and single-space owners verbatim, closeConnections with an exclusive change, PRIMARY, collations and the range's bounds");
        string DescribeRefused(string dialog, ObjectRefDto target)
        {
            try { service.Validate(new ActionDescribeArgs(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), dialog, target)); return "accepted"; }
            catch (RequestException error) { return error.Code; }
        }
        check(DescribeRefused("databaseProperties", new ObjectRefDto("database", Name: "master")) == "accepted" && DescribeRefused("databaseProperties", new ObjectRefDto("table", "AppData", "dbo", "Orders")) == "INVALID_PARAMS"
            && DescribeRefused("loginProperties", new ObjectRefDto("database", Name: "AppData")) == "INVALID_PARAMS" && DescribeRefused("deleteObject", new ObjectRefDto("database", Name: "master")) == "INVALID_PARAMS",
            "describe serves Database Properties on every database, master included, but not tables, unknown dialogs, or Delete Object on master");
    }

    private static string Script(DatabaseChangesDto changes, string database = "AppData", bool rollback = false, DatabaseAlter.Facts? facts = null)
    {
        var (plan, refusal) = DatabaseAlter.Plan(Catalog, database, changes, rollback, facts ?? Facts2022);
        return plan is null ? "refused: " + refusal : DatabaseAlter.ScriptText(Catalog, plan);
    }
    private static string Batches(params string[] lines) => string.Concat(lines.Select(line => line + NL + "GO" + NL));

    private static void Scripts(Action<bool, string> check)
    {
        // Each form as SMO's ScriptAlter writes it, with its spaces.
        var forms = new (string Key, string Token, string Text)[]
        {
            ("containmentType", "PARTIAL", "ALTER DATABASE [AppData] SET CONTAINMENT = PARTIAL WITH NO_WAIT"),
            ("compatibilityLevel", "150", "ALTER DATABASE [AppData] SET COMPATIBILITY_LEVEL = 150"),
            ("collation", "Latin1_General_CI_AS", "ALTER DATABASE [AppData] COLLATE Latin1_General_CI_AS"),
            ("ansiNullDefault", "true", "ALTER DATABASE [AppData] SET ANSI_NULL_DEFAULT ON WITH NO_WAIT"),
            ("autoClose", "false", "ALTER DATABASE [AppData] SET AUTO_CLOSE OFF WITH NO_WAIT"),
            ("autoCreateStatistics", "false", "ALTER DATABASE [AppData] SET AUTO_CREATE_STATISTICS OFF"),
            ("autoCreateIncrementalStatistics", "true", "ALTER DATABASE [AppData] SET AUTO_CREATE_STATISTICS ON(INCREMENTAL = ON)"),
            ("defaultCursor", "LOCAL", "ALTER DATABASE [AppData] SET CURSOR_DEFAULT  LOCAL WITH NO_WAIT"),
            ("brokerEnabled", "true", "ALTER DATABASE [AppData] SET  ENABLE_BROKER WITH NO_WAIT"),
            ("parameterization", "FORCED", "ALTER DATABASE [AppData] SET PARAMETERIZATION FORCED WITH NO_WAIT"),
            ("readOnly", "true", "ALTER DATABASE [AppData] SET  READ_ONLY WITH NO_WAIT"),
            ("recoveryModel", "BULK_LOGGED", "ALTER DATABASE [AppData] SET RECOVERY BULK_LOGGED WITH NO_WAIT"),
            ("restrictAccess", "SINGLE_USER", "ALTER DATABASE [AppData] SET  SINGLE_USER WITH NO_WAIT"),
            ("pageVerify", "CHECKSUM", "ALTER DATABASE [AppData] SET PAGE_VERIFY CHECKSUM  WITH NO_WAIT"),
            ("filestreamNonTransactedAccess", "FULL", "ALTER DATABASE [AppData] SET FILESTREAM( NON_TRANSACTED_ACCESS = FULL ) WITH NO_WAIT"),
            ("targetRecoveryTime", "60", "ALTER DATABASE [AppData] SET TARGET_RECOVERY_TIME = 60 SECONDS WITH NO_WAIT"),
            ("delayedDurability", "FORCED", "ALTER DATABASE [AppData] SET DELAYED_DURABILITY = FORCED WITH NO_WAIT")
        };
        var wrong = forms.Where(form => Script(Options((form.Key, form.Token))) != Batches("USE [master]", form.Text)).Select(form => form.Key).ToList();
        check(wrong.Count == 0, "each option's script is SMO's ALTER DATABASE under USE [master], double spaces and all: " + string.Join(", ", wrong));
        check(Script(Options(("readOnly", "true"), ("restrictAccess", "MULTI_USER")), rollback: true) == Batches("USE [master]", "ALTER DATABASE [AppData] SET  READ_ONLY WITH ROLLBACK IMMEDIATE",
                "ALTER DATABASE [AppData] SET  MULTI_USER WITH ROLLBACK IMMEDIATE")
            && Script(Options(("pageVerify", "NONE"), ("filestreamNonTransactedAccess", "OFF"), ("targetRecoveryTime", "0")), rollback: true) == Batches("USE [master]",
                "ALTER DATABASE [AppData] SET PAGE_VERIFY NONE  WITH ROLLBACK IMMEDIATE", "ALTER DATABASE [AppData] SET FILESTREAM( NON_TRANSACTED_ACCESS = OFF ) WITH ROLLBACK IMMEDIATE",
                "ALTER DATABASE [AppData] SET TARGET_RECOVERY_TIME = 0 SECONDS WITH ROLLBACK IMMEDIATE")
            && Script(Options(("compatibilityLevel", "140"), ("autoCreateStatistics", "true"), ("autoCreateIncrementalStatistics", "false")), rollback: true) == Batches("USE [master]",
                "ALTER DATABASE [AppData] SET COMPATIBILITY_LEVEL = 140", "ALTER DATABASE [AppData] SET AUTO_CREATE_STATISTICS ON(INCREMENTAL = OFF)"),
            "Yes to Open Connections writes WITH ROLLBACK IMMEDIATE wherever SMO terminates, and never on COMPATIBILITY_LEVEL or AUTO_CREATE_STATISTICS");
        check(Script(new(Scoped: new() { ["maxDop"] = "4", ["maxDopForSecondary"] = "PRIMARY", ["legacyCardinalityEstimation"] = "ON", ["queryOptimizerFixesForSecondary"] = "OFF" }))
            == Batches("USE [AppData]", "ALTER DATABASE SCOPED CONFIGURATION SET LEGACY_CARDINALITY_ESTIMATION = On;", "ALTER DATABASE SCOPED CONFIGURATION SET MAXDOP = 4;",
                "ALTER DATABASE SCOPED CONFIGURATION FOR SECONDARY SET MAXDOP = PRIMARY;", "ALTER DATABASE SCOPED CONFIGURATION FOR SECONDARY SET QUERY_OPTIMIZER_HOTFIXES = Off;"),
            "scoped configurations run under USE [db] in SMO's name order, primary then secondary, with SMO's On, Off and PRIMARY");
        check(Script(Options(("allowSnapshotIsolation", "true"))) == Batches("ALTER DATABASE [AppData] SET ALLOW_SNAPSHOT_ISOLATION ON")
            && Script(new(Owner: "ap]p")) == Batches("USE [AppData]", "ALTER AUTHORIZATION ON DATABASE::[AppData] TO [ap]]p]"),
            "SetSnapshotIsolation's statement has no USE and no termination; SetOwner writes USE [db] and ALTER AUTHORIZATION with the login QUOTENAME'd");
        // Everything at once, in SSMS's order.
        var all = Script(new(Owner: "sa", Options: new() { ["allowSnapshotIsolation"] = "false", ["recoveryModel"] = "SIMPLE", ["autoClose"] = "true", ["containmentType"] = "NONE", ["collation"] = "Latin1_General_BIN2" },
            Scoped: new() { ["parameterSniffing"] = "OFF" }), "o]dd'db");
        check(all == Batches("USE [master]", "ALTER DATABASE [o]]dd'db] SET CONTAINMENT = NONE WITH NO_WAIT", "ALTER DATABASE [o]]dd'db] COLLATE Latin1_General_BIN2",
                "ALTER DATABASE [o]]dd'db] SET AUTO_CLOSE ON WITH NO_WAIT", "ALTER DATABASE [o]]dd'db] SET RECOVERY SIMPLE WITH NO_WAIT", "USE [o]]dd'db]",
                "ALTER DATABASE SCOPED CONFIGURATION SET PARAMETER_SNIFFING = Off;", "ALTER DATABASE [o]]dd'db] SET ALLOW_SNAPSHOT_ISOLATION OFF", "USE [o]]dd'db]",
                "ALTER AUTHORIZATION ON DATABASE::[o]]dd'db] TO [sa]"),
            "a combined change scripts in SSMS's order: containment, collation, the SET options, scoped configurations, snapshot isolation, then the owner:\n" + all);
        // The query window splits a hostile name's script where SSMS's does.
        var failures = new List<string>();
        foreach (var fragment in InjectionMatrix.Fragments.Append("]").Append("'").Append(" ").Append("‮"))
        {
            var name = ActionChecks.Long(fragment);
            var plan = DatabaseAlter.Plan(Catalog, name, new(Owner: name, Options: new() { ["autoClose"] = "true" }, Scoped: new() { ["maxDop"] = "2" }), false, Facts2022).Plan!;
            var batches = SqlScript.Parse(DatabaseAlter.ScriptText(Catalog, plan));
            if (batches.Count != 6) failures.Add(fragment[..1] + " splits into " + batches.Count);
        }
        check(failures.Count == 0, "Database Properties' script of hostile 128-unit names splits into exactly SSMS's batches: " + string.Join("; ", failures));
    }

    private static void Plans(Action<bool, string> check)
    {
        string Refusal(DatabaseChangesDto changes, string database = "AppData", DatabaseAlter.Facts? facts = null) => DatabaseAlter.Plan(Catalog, database, changes, false, facts ?? Facts2022).Refusal ?? "";
        check(Refusal(Options(("recoveryModel", "FULL")), "tempdb") == "SQL Server does not allow changing Recovery model on tempdb."
            && Refusal(Options(("readOnly", "true")), "master") == "SQL Server does not allow changing Database Read-Only on master."
            && Refusal(new(Owner: "sa"), "model") == "SQL Server does not allow changing the owner of model." && Refusal(new(Owner: "sa"), "msdb") == ""
            && Refusal(Options(("compatibilityLevel", "170"))) == "This server does not offer compatibility level 170."
            && Refusal(new(Scoped: new() { ["maxDop"] = "1" }), facts: new(12, 120, true)) == "Max DOP needs a newer version of SQL Server.",
            "the plan refuses what SQL Server refuses on its own databases (Learn's master, model, msdb and tempdb pages), levels above the server's, and options before their version");
        var off = DatabaseAlter.Plan(Catalog, "AppData", Options(("autoCreateIncrementalStatistics", "true")), false, new(16, 160, AutoCreateStatistics: false)).Plan!;
        var first = DatabaseAlter.Plan(Catalog, "AppData", Options(("autoCreateIncrementalStatistics", "true"), ("autoCreateStatistics", "false")), false, Facts2022).Plan!;
        check(off.Count == 0 && first.Single().Token == "OFF" && first.Single().Title == "Auto Create Statistics",
            "INCREMENTAL is written only when Auto Create Statistics ends up on, as SMO's ScriptAutoCreateStatistics does");
        var plan = DatabaseAlter.Plan(Catalog, "AppData", new(Owner: "sa", Options: new() { ["readOnly"] = "true", ["autoClose"] = "true" }), false, Facts2022).Plan!;
        check(plan.Select(statement => statement.Title).SequenceEqual(["Auto Close", "Database Read-Only", "Owner"]) && plan.All(statement => !statement.Rollback),
            "each statement is a step titled by its option's label, in SMO's order, and the owner last");
    }

    private static void Lint(Action<bool, string> check)
    {
        var results = DatabaseAlter.Lint(Catalog).ToList();
        var problems = results.SelectMany(result => result.Problems.Select(problem => result.Name + ": " + problem)).ToList();
        var corpus = DatabaseAlter.Corpus(Catalog).ToList();
        check(problems.Count == 0 && results.Count == corpus.Count * 2 && corpus.Select(statement => statement.Template).Distinct().Count() == Enum.GetValues<AlterTemplate>().Length,
            "every Database Properties batch the catalogue can plan passes the lint, run and dry run, for every template, token and termination (" + results.Count + "): " + string.Join("; ", problems.Take(5)));
        var good = DatabaseAlter.Executable(Catalog, new(AlterTemplate.Owner, "db", "owner", Name: "x"));
        var mutations = new (string Name, string Text)[]
        {
            ("a bare name parameter", good.Replace("QUOTENAME(@p2)", "@p2", StringComparison.Ordinal)),
            ("a name spliced into a literal", good.Replace("N' TO '", "N' TO [x]'", StringComparison.Ordinal)),
            ("a comment in a literal", good.Replace("N' TO '", "N' TO --'", StringComparison.Ordinal)),
            ("no quoting guard", good.Replace("IF @stmt IS NULL THROW 50000, N'A name could not be quoted.', 1;\n", "", StringComparison.Ordinal)),
            ("a number without its guard", DatabaseAlter.Executable(Catalog, new(AlterTemplate.Compat, "db", "compatibilityLevel", Number: 150))[(DatabaseAlter.Executable(Catalog, new(AlterTemplate.Compat, "db", "compatibilityLevel", Number: 150)).IndexOf('\n') + 1)..]),
            ("a format hole", good.Replace("N' TO '", "N' TO {0}'", StringComparison.Ordinal)),
            ("an undeclared variable", good.Replace("QUOTENAME(@p2)", "QUOTENAME(@other)", StringComparison.Ordinal))
        };
        var missed = mutations.Where(mutation => DatabaseAlter.LintExecutable(mutation.Text).Count == 0).Select(mutation => mutation.Name).ToList();
        check(missed.Count == 0 && DatabaseAlter.LintExecutable(good).Count == 0, "the lint catches bare and spliced names, a comment in a literal, a missing guard, an unguarded number, format holes and undeclared variables: " + string.Join(", ", missed));
        check(corpus.All(statement => DatabaseAlter.Executable(Catalog, statement) == DatabaseAlter.Executable(Catalog, statement with { Database = ActionChecks.Long(InjectionMatrix.Fragments[0]), Name = "other" })),
            "a batch's text never depends on the database, the collation or the login: they are parameters");
    }

    private static void Describe(Action<bool, string> check)
    {
        check(DatabaseProperties.Growth(0, false, -1) == new GrowthDto(false) && DatabaseProperties.Growth(8192, false, -1) == new GrowthDto(true, "mb", 64)
            && DatabaseProperties.Growth(10, true, 268435456) == new GrowthDto(true, "percent", 10, 2097152) && DatabaseProperties.Growth(128, false, 1280) == new GrowthDto(true, "mb", 1, 10),
            "file growth reads as SSMS's Autogrowth: none, MB or percent, unlimited or limited in MB");
        check(DatabaseProperties.SplitPath(@"C:\Data\App.mdf") == (@"C:\Data", "App.mdf") && DatabaseProperties.SplitPath("/var/opt/mssql/data/app.mdf") == ("/var/opt/mssql/data", "app.mdf")
            && DatabaseProperties.SplitPath("app.mdf") == ("", "app.mdf"), "a physical name splits into Path and File Name on either separator");
        check(DatabaseProperties.ScopedToken("MAXDOP", "8", false) == "8" && DatabaseProperties.ScopedToken("MAXDOP", null, true) == "PRIMARY" && DatabaseProperties.ScopedToken("PARAMETER_SNIFFING", "1", false) == "ON"
            && DatabaseProperties.ScopedToken("LEGACY_CARDINALITY_ESTIMATION", "0", true) == "OFF" && DatabaseProperties.Token("defaultCursor", true) == "LOCAL"
            && DatabaseProperties.Token("allowSnapshotIsolation", 3) == "true" && DatabaseProperties.Token("allowSnapshotIsolation", 2) == "false" && DatabaseProperties.Token("compatibilityLevel", (byte)160) == "160"
            && DatabaseProperties.Token("autoClose", false) == "false" && DatabaseProperties.Token("recoveryModel", "SIMPLE") == "SIMPLE",
            "sys.databases and sys.database_scoped_configurations values read as the catalogue's tokens");
    }

    private sealed class NoHost : IActionHost
    {
        public ServerProfile Profile(string connectionId) => throw new RequestException("NOT_CONNECTED", "Not connected.");
        public Microsoft.Data.SqlClient.SqlConnection Connection(string connectionId) => throw new InvalidOperationException();
        public Task OpenAsync(Microsoft.Data.SqlClient.SqlConnection connection, CancellationToken token) => Task.CompletedTask;
        public void ClearPoolsFor(string connectionId, string database) { }
        public void DatabaseChanged(string connectionId, string database, string? newName) { }
    }
}
