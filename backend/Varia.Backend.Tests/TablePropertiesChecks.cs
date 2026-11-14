using Varia.Backend.Actions;
using Varia.Backend.Explorer;
using Varia.Backend.Protocol;
using Varia.Backend.Scripting;

namespace Varia.Backend.Tests;

/// <summary>Offline Table Properties checks: the embedded catalogue, validation parity with zod, SSMS's script text for every
/// statement, the plan's order and refusals, the builder and procedure batches with the mutations their lint must catch, and the
/// reads' lint at every band.</summary>
internal static class TablePropertiesChecks
{
    private static readonly ActionsCatalog Catalog = ActionsCatalog.Current;
    private static readonly string NL = ScriptFormatter.NewLine;
    private static string Id() => Guid.NewGuid().ToString();
    private static readonly ObjectRefDto Orders = new("table", Database: "AppData", Schema: "Sales", Name: "Orders");
    private static readonly TableProperties.Facts Plain = new(901, "2026-01-01T00:00:00.000", false, false, "TABLE", false, false, false, false, true);
    private static ActionArgs Properties(TableChangesDto changes, ObjectRefDto? target = null) => new("tableProperties", Id(), Id(), target ?? Orders, TableChanges: changes);

    public static void Run(Action<bool, string> check)
    {
        CatalogChecks(check);
        Validation(check);
        Plans(check);
        Scripts(check);
        Batches(check);
        Lint(check);
    }

    private static void CatalogChecks(Action<bool, string> check)
    {
        var tables = Catalog.Tables;
        check(tables.LockEscalation.SequenceEqual(["TABLE", "AUTO", "DISABLE"]) && tables.ExtendedPropertyOps.SequenceEqual(["add", "update", "drop"])
            && tables.Limit("extendedPropertyValue") == 3750 && tables.Limit("extendedPropertyChanges") == 64 && tables.Limit("permissions") > 0
            && tables.Step("lockEscalation") == "Set lock escalation" && tables.Message("rolledBack").Contains("rolled back", StringComparison.Ordinal),
            "the embedded catalogue carries tables.ts' lock escalations, extended property operations, limits, step titles and messages");
        check(Catalog.KindActionOf("table", "properties") == "tableProperties" && Catalog.KindOf("tableProperties") == "table" && Catalog.Offered("table", "properties")
            && Catalog.ServesSystemObjects("properties"), "a table's Properties routes to Table Properties, which opens on every table, SQL Server's own included");
    }

    private static void Validation(Action<bool, string> check)
    {
        using var service = new ActionService(new ActionChecks.FakeHost());
        string Refused(ActionArgs args, bool script = false)
        {
            try { service.Validate(args, script); return "accepted"; }
            catch (RequestException error) { return error.Code; }
        }
        var identity = new DatabaseIdentityDto(901, "2026-01-01T00:00:00.000");
        var accepted = new[]
        {
            Properties(new("AUTO", null, null)),
            Properties(new(null, new(true, true), null)) with { Identity = identity },
            Properties(new(null, new(false, null), [new("drop", "Old", null), new("add", "MS_Description", "Orders, it's"), new("update", "Owner", new string('x', 3750))])),
            Properties(new("DISABLE", null, null), new ObjectRefDto("table", Database: "master", Schema: "sys", Name: "spt_values")),
        }.Select(args => Refused(args)).ToList();
        check(accepted.All(result => result == "accepted"), "Validate accepts Table Properties' changes zod accepts: " + string.Join(", ", accepted));
        var props = (int count) => Enumerable.Range(0, count).Select(index => new ExtendedPropertyChangeDto("add", "p" + index, "v")).ToList();
        var refused = new (string Name, ActionArgs Args)[]
        {
            ("no changes", new("tableProperties", Id(), Id(), Orders)),
            ("empty changes", Properties(new(null, null, null))),
            ("empty list", Properties(new(null, null, []))),
            ("unknown lock escalation", Properties(new("ROW", null, null))),
            ("lower-case lock escalation", Properties(new("auto", null, null))),
            ("track columns with tracking off", Properties(new(null, new(false, true), null))),
            ("unknown op", Properties(new(null, null, [new("set", "a", "b")]))),
            ("drop with a value", Properties(new(null, null, [new("drop", "a", "b")]))),
            ("add without a value", Properties(new(null, null, [new("add", "a", null)]))),
            ("empty name", Properties(new(null, null, [new("add", "", "b")]))),
            ("long name", Properties(new(null, null, [new("add", new string('n', 129), "b")]))),
            ("long value", Properties(new(null, null, [new("add", "a", new string('x', 3751))]))),
            ("NUL value", Properties(new(null, null, [new("add", "a", "b\0")]))),
            ("lone surrogate", Properties(new(null, null, [new("add", "a", "b\uD800")]))),
            ("a name twice", Properties(new(null, null, [new("add", "a", "b"), new("drop", "a", null)]))),
            ("too many", Properties(new(null, null, props(65)))),
            ("bad identity", Properties(new("AUTO", null, null)) with { Identity = new(0, "2026-01-01T00:00:00.000") }),
            ("a new name too", Properties(new("AUTO", null, null)) with { NewName = "x" }),
            ("a database's changes too", Properties(new("AUTO", null, null)) with { Changes = new(Owner: "sa") }),
            ("a login's identity too", Properties(new("AUTO", null, null)) with { LoginIdentity = new("01", "2026-01-01T00:00:00.000") }),
            ("secrets", Properties(new("AUTO", null, null)) with { Secrets = new("x") }),
            ("not a table", Properties(new("AUTO", null, null), new ObjectRefDto("view", Database: "AppData", Schema: "dbo", Name: "v"))),
            ("another action's changes", new ActionArgs("rename", Id(), Id(), Orders, NewName: "o2", TableChanges: new("AUTO", null, null))),
        }.Where(item => Refused(item.Args) != "INVALID_PARAMS").Select(item => item.Name).ToList();
        check(refused.Count == 0, "Validate refuses what zod refuses for Table Properties: " + string.Join(", ", refused));
    }

    private static (List<TableStatement>? Plan, string? Refusal) Plan(TableChangesDto changes, TableProperties.Facts? facts = null) =>
        TableAlter.Plan(Catalog, "AppData", "Sales", "Orders", changes, facts ?? Plain);

    private static void Plans(Action<bool, string> check)
    {
        var tables = Catalog.Tables;
        var all = Plan(new("AUTO", new(true, true), [new("add", "C", "c"), new("drop", "A", null), new("update", "B", "b")])).Plan!;
        check(all.Select(statement => statement.Template).SequenceEqual([TableTemplate.LockEscalation, TableTemplate.EnableTracking, TableTemplate.DropProperty, TableTemplate.UpdateProperty, TableTemplate.AddProperty])
            && all[1].Token == "ON" && all.Select(statement => statement.Title).SequenceEqual(["Set lock escalation", "Turn on change tracking", "Remove the extended property", "Change the extended property", "Add the extended property"]),
            "the plan sets lock escalation, then change tracking, then drops, changes and adds extended properties, with SSMS's step titles");
        var tracked = Plain with { Tracking = true, TrackColumns = false };
        check(Plan(new(null, new(true, true), null), tracked).Plan!.Select(statement => statement.Template + ":" + statement.Token).SequenceEqual(["DisableTracking:", "EnableTracking:ON"])
            && Plan(new(null, new(false, null), null), tracked).Plan!.Single().Template == TableTemplate.DisableTracking
            && Plan(new(null, new(true, null), null), tracked).Refusal == tables.Message("nothingToChange")
            && Plan(new(null, new(true, null), null)).Plan!.Single().Token == "OFF"
            && Plan(new("TABLE", null, null)).Refusal == tables.Message("nothingToChange")
            && Plan(new(null, new(false, null), null)).Refusal == tables.Message("nothingToChange"),
            "change tracking turns off and on again only to change Track columns updated, and a change the table already has plans nothing");
        check(Plan(new("AUTO", null, null), Plain with { System = true }).Refusal == tables.Message("systemTable")
            && Plan(new("AUTO", null, null), Plain with { External = true }).Refusal == tables.Message("externalTable")
            && Plan(new("AUTO", null, null), Plain with { DroppedLedger = true }).Refusal == tables.Message("droppedLedger")
            && Plan(new("AUTO", null, null), Plain with { MemoryOptimized = true }).Refusal == tables.Message("memoryOptimized")
            && Plan(new(null, new(true, null), null), Plain with { PrimaryKey = false }).Refusal == tables.Message("primaryKey")
            && Plan(new(null, null, [new("add", "MS_Description", "x")]), Plain with { MemoryOptimized = true }).Plan is { Count: 1 },
            "the plan refuses SQL Server's own, external and dropped ledger tables, lock escalation on a memory-optimized table and change tracking without a primary key");
        check(TableAlter.NeedsDatabaseTracking(all) && !TableAlter.NeedsDatabaseTracking(Plan(new(null, new(false, null), null), tracked).Plan!),
            "only turning change tracking on needs the database to track changes");
    }

    private static void Scripts(Action<bool, string> check)
    {
        TableStatement S(TableTemplate template, string? token = null, string? name = null, string? value = null) => new(template, "App]Data", "Sa]les", "Or'ders", token, name, value);
        check(TableAlter.Statement(Catalog, S(TableTemplate.LockEscalation, "AUTO")) == "ALTER TABLE [Sa]]les].[Or'ders] SET (LOCK_ESCALATION = AUTO)"
            && TableAlter.Statement(Catalog, S(TableTemplate.EnableTracking, "ON")) == "ALTER TABLE [Sa]]les].[Or'ders] ENABLE CHANGE_TRACKING WITH (TRACK_COLUMNS_UPDATED = ON)"
            && TableAlter.Statement(Catalog, S(TableTemplate.DisableTracking)) == "ALTER TABLE [Sa]]les].[Or'ders] DISABLE CHANGE_TRACKING"
            && TableAlter.Statement(Catalog, S(TableTemplate.AddProperty, name: "MS_Description", value: "it's")) == "EXEC sys.sp_addextendedproperty @name = N'MS_Description', @value = N'it''s', @level0type = N'SCHEMA', @level0name = N'Sa]les', @level1type = N'TABLE', @level1name = N'Or''ders'"
            && TableAlter.Statement(Catalog, S(TableTemplate.UpdateProperty, name: "a", value: "")) == "EXEC sys.sp_updateextendedproperty @name = N'a', @value = N'', @level0type = N'SCHEMA', @level0name = N'Sa]les', @level1type = N'TABLE', @level1name = N'Or''ders'"
            && TableAlter.Statement(Catalog, S(TableTemplate.DropProperty, name: "a")) == "EXEC sys.sp_dropextendedproperty @name = N'a', @level0type = N'SCHEMA', @level0name = N'Sa]les', @level1type = N'TABLE', @level1name = N'Or''ders'",
            "each statement is SSMS's text: names bracket-quoted in ALTER TABLE, N'' literals with doubled quotes in the procedures");
        var script = TableAlter.ScriptText(Catalog, [S(TableTemplate.LockEscalation, "DISABLE"), S(TableTemplate.DropProperty, name: "a")]);
        check(script == "USE [App]]Data]" + NL + "GO" + NL + "SET XACT_ABORT ON;" + NL + "BEGIN TRANSACTION;" + NL + "ALTER TABLE [Sa]]les].[Or'ders] SET (LOCK_ESCALATION = DISABLE);" + NL
                + "EXEC sys.sp_dropextendedproperty @name = N'a', @level0type = N'SCHEMA', @level0name = N'Sa]les', @level1type = N'TABLE', @level1name = N'Or''ders';" + NL + "COMMIT TRANSACTION;" + NL + "GO" + NL,
            "Script runs the statements in one transaction in the table's database, as Apply does");
        var threw = false;
        try { _ = TableAlter.Statement(Catalog, S(TableTemplate.LockEscalation, "ROW); DROP TABLE x;--")); } catch (InvalidOperationException) { threw = true; }
        check(threw, "a lock escalation outside the catalogue never reaches the text");
    }

    private static void Batches(Action<bool, string> check)
    {
        var alter = TableAlter.Executable(Catalog, new(TableTemplate.EnableTracking, "d", "s", "t", "OFF"));
        check(alter == "DECLARE @stmt nvarchar(max) = N'ALTER TABLE ' + QUOTENAME(@p1) + N'.' + QUOTENAME(@p2) + N' ENABLE CHANGE_TRACKING WITH (TRACK_COLUMNS_UPDATED = OFF)';\n" + ActionSql.Guard
                + "DECLARE @module nvarchar(300) = QUOTENAME(@db) + N'.sys.sp_executesql';\nEXEC @module @stmt;"
            && TableAlter.Executable(Catalog, new(TableTemplate.DisableTracking, "d", "s", "t"), dryRun: true).EndsWith("SELECT @stmt AS stmt;", StringComparison.Ordinal),
            "an ALTER TABLE is a builder batch: SQL Server quotes the schema and table and runs it in the database; its dry run returns the text");
        var add = TableAlter.Executable(Catalog, new(TableTemplate.AddProperty, "d", "s", "t", Name: "n", Value: "v"));
        var drop = TableAlter.Executable(Catalog, new(TableTemplate.DropProperty, "d", "s", "t", Name: "n"));
        check(add == "DECLARE @proc nvarchar(300) = QUOTENAME(@db) + N'.sys.sp_addextendedproperty';\nIF @proc IS NULL THROW 50000, N'A name could not be quoted.', 1;\n"
                + "EXEC @proc @name = @p3, @value = @v1, @level0type = N'SCHEMA', @level0name = @p1, @level1type = N'TABLE', @level1name = @p2;"
            && !drop.Contains("@v1", StringComparison.Ordinal) && drop.Contains("sp_dropextendedproperty", StringComparison.Ordinal),
            "an extended property is the database's own procedure, with the names and value as its arguments, never in text");
        var mutations = new (string Name, string Text)[]
        {
            ("spliced name", add.Replace("@level0name = @p1", "@level0name = N'dbo'", StringComparison.Ordinal)),
            ("value in text", add.Replace("@value = @v1", "@value = N'x'", StringComparison.Ordinal)),
            ("parameter outside an argument", add.Replace("QUOTENAME(@db) + N'.sys", "@db + N'.sys", StringComparison.Ordinal)),
            ("dynamic SQL", add + "\nEXEC (@p3);"),
            ("no guard", add.Replace("IF @proc IS NULL THROW 50000, N'A name could not be quoted.', 1;\n", "", StringComparison.Ordinal)),
            ("format hole", add.Replace("@p3", "{0}", StringComparison.Ordinal)),
            ("another procedure", add.Replace("sp_addextendedproperty", "sp_executesql", StringComparison.Ordinal)),
        }.Where(item => TableAlter.LintProcedure(item.Text).Count == 0).Select(item => item.Name).ToList();
        check(TableAlter.LintProcedure(add).Count == 0 && TableAlter.LintProcedure(drop).Count == 0 && mutations.Count == 0,
            "the procedure lint passes the real batches and catches each misuse: " + string.Join(", ", mutations));
        var alterMutations = new (string Name, string Text)[]
        {
            ("bare name", alter.Replace("QUOTENAME(@p2)", "@p2", StringComparison.Ordinal)),
            ("spliced name", alter.Replace("QUOTENAME(@p1)", "N'[dbo]'", StringComparison.Ordinal)),
            ("hostile keyword", alter.Replace("N' ENABLE CHANGE_TRACKING WITH (TRACK_COLUMNS_UPDATED = OFF)'", "N' DROP COLUMN x; --'", StringComparison.Ordinal)),
        }.Where(item => ActionSql.LintExecutable(item.Text, TableAlter.Messages).Count == 0).Select(item => item.Name).ToList();
        check(ActionSql.LintExecutable(alter, TableAlter.Messages).Count == 0 && alterMutations.Count == 0, "the builder lint passes the ALTER TABLE batch and catches each misuse: " + string.Join(", ", alterMutations));
    }

    private static void Lint(Action<bool, string> check)
    {
        var lint = TableAlter.Lint(Catalog).ToList();
        var problems = lint.SelectMany(item => item.Problems.Select(problem => item.Name + ": " + problem)).ToList();
        check(lint.Count == (Catalog.Tables.LockEscalation.Count + 3) * 2 + 3 + 1 + 2 * (ExplorerCatalog.MaxBand - ExplorerCatalog.MinBand + 1) && problems.Count == 0,
            "every Table Properties batch and read passes the lint at every band: " + string.Join("; ", problems.Take(5)));
        check(!TableProperties.Inside(ExplorerCatalog.MinBand, Catalog.Tables).Contains("sys.security_predicates", StringComparison.Ordinal)
            && TableProperties.Inside(ExplorerCatalog.MaxBand, Catalog.Tables).Contains("sys.security_predicates", StringComparison.Ordinal)
            && TableProperties.Inside(ExplorerCatalog.MaxBand, Catalog.Tables).Contains("TOP (" + (Catalog.Tables.Limit("permissions") + 1) + ")", StringComparison.Ordinal),
            "the describe reads security predicates only where SQL Server has them, and one permission row past the catalogue's bound");
    }
}
