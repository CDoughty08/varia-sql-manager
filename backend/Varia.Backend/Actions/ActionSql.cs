using System.Globalization;
using System.Text.RegularExpressions;
using Varia.Backend.Explorer;
using Varia.Backend.Scripting;

namespace Varia.Backend.Actions;

/// <summary>The statements an action runs: DROP TABLE, VIEW, PROCEDURE or FUNCTION, sp_rename, ALTER DATABASE … MODIFY NAME,
/// SET SINGLE_USER, DROP DATABASE and msdb's backup history cleanup.</summary>
internal enum ActionTemplate { DropTable, DropView, DropProcedure, DropFunction, RenameObject, RenameDatabase, SetSingleUser, DropDatabase, DeleteBackupHistory }

/// <summary>One statement of an action: its template, the database it runs in, and the names it takes, verbatim (a
/// schema-scoped object's schema and name, then a new name; a database's name, then a new name).</summary>
internal sealed record PlannedStatement(ActionTemplate Template, string Database, IReadOnlyList<string> Names);

/// <summary>All SQL of the action path, as constant text per template, kind and version band. DDL is built by SQL Server
/// from that text: names reach it only as nvarchar(128) parameters (@db, @p1…) passed through QUOTENAME, or as a
/// procedure's own argument, so no name can change what a statement does. <see cref="ScriptText"/> renders the same
/// statement as SSMS writes it, for the Script button; the live checks prove both agree for every hostile name.</summary>
internal static partial class ActionSql
{
    public static string NL => ScriptFormatter.NewLine;
    /// <summary>The action connection's settings. DDL waits for locks as SSMS does (no LOCK_TIMEOUT); Stop cancels it.</summary>
    public const string Prologue = "SET NOCOUNT ON; SET XACT_ABORT ON; SET DEADLOCK_PRIORITY NORMAL; SET ANSI_NULLS ON; SET QUOTED_IDENTIFIER ON; SET ANSI_PADDING ON; "
        + "SET ANSI_WARNINGS ON; SET CONCAT_NULL_YIELDS_NULL ON; SET ARITHABORT ON; SET TRANSACTION ISOLATION LEVEL READ COMMITTED;";
    /// <summary>Describe and script requests only read, and give up behind another session's DDL after 10 s (BLOCKED).</summary>
    public const string ReadPrologue = Prologue + " SET LOCK_TIMEOUT 10000;";
    /// <summary>Execute requests restore the default after a describe on the same connection could have set it.</summary>
    public const string ExecutePrologue = Prologue + " SET LOCK_TIMEOUT -1;";

    public const string Declarations = "@schema sysname, @name sysname, @new sysname, @take int";
    /// <summary>Runs a catalog statement in the object's database, which reaches T-SQL only through QUOTENAME.</summary>
    public const string ModuleCall = "DECLARE @module nvarchar(300) = QUOTENAME(@db) + N'.sys.sp_executesql';\n"
        + "EXEC @module @stmt, @decl, @schema = @schema, @name = @name, @new = @new, @take = @take;";
    private const string Guard = "IF @stmt IS NULL THROW 50000, N'A name could not be quoted.', 1;\n";

    public static string Quote(string name) => ScriptFormatter.Quote(name);
    private static string Literal(string value) => "N'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";

    public static int ParameterCount(ActionTemplate template) => template switch
    {
        ActionTemplate.DropTable or ActionTemplate.DropView or ActionTemplate.DropProcedure or ActionTemplate.DropFunction or ActionTemplate.RenameDatabase => 2,
        ActionTemplate.RenameObject => 3,
        _ => 1
    };

    private static string DropKeyword(ActionTemplate template) => template switch
    {
        ActionTemplate.DropTable => "TABLE",
        ActionTemplate.DropView => "VIEW",
        ActionTemplate.DropProcedure => "PROCEDURE",
        ActionTemplate.DropFunction => "FUNCTION",
        _ => throw new InvalidOperationException("Not a DROP of a schema object: " + template)
    };

    /// <summary>The template a kind's DROP uses.</summary>
    public static ActionTemplate DropOf(string kind) => kind switch
    {
        "table" => ActionTemplate.DropTable,
        "view" => ActionTemplate.DropView,
        "procedure" => ActionTemplate.DropProcedure,
        "function" => ActionTemplate.DropFunction,
        _ => throw new InvalidOperationException("No DROP for " + kind)
    };

    /// <summary>The statement itself as SSMS writes it, names quoted by C#'s QUOTENAME.</summary>
    public static string Statement(PlannedStatement plan)
    {
        var names = plan.Names;
        return plan.Template switch
        {
            ActionTemplate.DropTable or ActionTemplate.DropView or ActionTemplate.DropProcedure or ActionTemplate.DropFunction => "DROP " + DropKeyword(plan.Template) + " " + Quote(names[0]) + "." + Quote(names[1]),
            ActionTemplate.RenameObject => "EXEC sys.sp_rename @objname = " + Literal(Quote(names[0]) + "." + Quote(names[1])) + ", @newname = " + Literal(names[2]) + ", @objtype = N'OBJECT'",
            ActionTemplate.RenameDatabase => "ALTER DATABASE " + Quote(names[0]) + " MODIFY NAME = " + Quote(names[1]),
            ActionTemplate.SetSingleUser => "ALTER DATABASE " + Quote(names[0]) + " SET  SINGLE_USER WITH ROLLBACK IMMEDIATE",
            ActionTemplate.DropDatabase => "DROP DATABASE " + Quote(names[0]),
            ActionTemplate.DeleteBackupHistory => "EXEC msdb.dbo.sp_delete_database_backuphistory @database_name = " + Literal(names[0]),
            _ => throw new InvalidOperationException("Unknown template " + plan.Template)
        };
    }

    /// <summary>SSMS's script of one statement: USE and GO around it (no USE before msdb's procedure, which names its database).</summary>
    public static string ScriptText(PlannedStatement plan) =>
        (plan.Template == ActionTemplate.DeleteBackupHistory ? "" : "USE " + Quote(plan.Database) + NL + "GO" + NL) + Statement(plan) + NL + "GO" + NL;

    /// <summary>The batch that runs a statement: SQL Server builds it from parameters (@db, then @p1… in the plan's name order).
    /// <paramref name="dryRun"/> (the live checks only, never the wire) selects what would run instead of running it.</summary>
    public static string Executable(ActionTemplate template, bool dryRun = false)
    {
        string Run(string build) => build + Guard + (dryRun ? "SELECT @stmt AS stmt;" : "DECLARE @module nvarchar(300) = QUOTENAME(@db) + N'.sys.sp_executesql';\nEXEC @module @stmt;");
        return template switch
        {
            ActionTemplate.DropTable or ActionTemplate.DropView or ActionTemplate.DropProcedure or ActionTemplate.DropFunction =>
                Run("DECLARE @stmt nvarchar(max) = N'DROP " + DropKeyword(template) + " ' + QUOTENAME(@p1) + N'.' + QUOTENAME(@p2);\n"),
            // sp_rename parses @objname itself; the new name is its own argument, never part of any text.
            ActionTemplate.RenameObject => "DECLARE @stmt nvarchar(1035) = QUOTENAME(@p1) + N'.' + QUOTENAME(@p2);\n" + Guard
                + (dryRun ? "SELECT @stmt AS stmt, @p3 AS new_name;" : "DECLARE @rename nvarchar(300) = QUOTENAME(@db) + N'.sys.sp_rename';\nEXEC @rename @objname = @stmt, @newname = @p3, @objtype = N'OBJECT';"),
            ActionTemplate.RenameDatabase => Run("DECLARE @stmt nvarchar(max) = N'ALTER DATABASE ' + QUOTENAME(@p1) + N' MODIFY NAME = ' + QUOTENAME(@p2);\n"),
            ActionTemplate.SetSingleUser => Run("DECLARE @stmt nvarchar(max) = N'ALTER DATABASE ' + QUOTENAME(@p1) + N' SET  SINGLE_USER WITH ROLLBACK IMMEDIATE';\n"),
            ActionTemplate.DropDatabase => Run("DECLARE @stmt nvarchar(max) = N'DROP DATABASE ' + QUOTENAME(@p1);\n"),
            ActionTemplate.DeleteBackupHistory => dryRun ? "SELECT @p1 AS database_name;" : "EXEC msdb.dbo.sp_delete_database_backuphistory @database_name = @p1;",
            _ => throw new InvalidOperationException("Unknown template " + template)
        };
    }

    // --- Catalog statements ---------------------------------------------------------------------------------------------

    /// <summary>The object's database as master sees it: whether it exists, is online, and the login can open it.</summary>
    public const string DatabaseState = "SELECT d.database_id AS database_id, d.state AS state, d.state_desc AS state_desc, "
        + "CONVERT(bit, ISNULL(CASE WHEN d.user_access = 1 THEN 1 ELSE HAS_DBACCESS(d.name) END, 0)) AS has_access FROM sys.databases AS d WHERE d.name = @db;";

    /// <summary>The sys.objects types a kind's object is found by.</summary>
    public static string Types(string kind) => kind switch
    {
        "table" => "'U'",
        "view" => "'V'",
        "procedure" => "'P', 'PC', 'X', 'RF'",
        "function" => "'FN', 'IF', 'TF', 'FS', 'FT', 'AF'",
        _ => throw new InvalidOperationException("No object lookup for " + kind)
    };

    private const string Owner = "LEFT JOIN sys.database_principals AS op ON op.principal_id = COALESCE(o.principal_id, s.principal_id) ";
    /// <summary>Advisory permission checks (SQL Server enforces the real ones), and whether @new is taken in the schema. A
    /// check that cannot answer (NULL) does not refuse.</summary>
    private const string Checks = "CONVERT(bit, ISNULL(HAS_PERMS_BY_NAME(QUOTENAME(s.name) + N'.' + QUOTENAME(o.name), N'OBJECT', N'ALTER'), 1)) AS can_alter, "
        + "CONVERT(bit, CASE WHEN ISNULL(HAS_PERMS_BY_NAME(s.name, N'SCHEMA', N'ALTER'), 1) = 1 OR HAS_PERMS_BY_NAME(QUOTENAME(s.name) + N'.' + QUOTENAME(o.name), N'OBJECT', N'CONTROL') = 1 "
        + "THEN 1 ELSE 0 END) AS can_drop, "
        + "CONVERT(bit, CASE WHEN EXISTS (SELECT 1 FROM sys.objects AS x WHERE x.schema_id = o.schema_id AND x.name = @new AND x.object_id <> o.object_id) THEN 1 ELSE 0 END) AS name_in_use";

    /// <summary>One statement per kind and band, run in the object's database: the object's row (its subtype's columns as
    /// ScriptPreflight.Subtype reads them, its owner, permissions and a name collision), then at most @take tables whose
    /// foreign keys reference it, then at most @take schema-bound modules over it. Execute passes @take 0.</summary>
    public static string Object(string kind, int band)
    {
        var render = new SqlRender(band);
        var subtype = kind switch
        {
            "table" => render.Col(13, "t.temporal_type", "CONVERT(tinyint, 0)") + " AS temporal_code, " + render.Col(16, "t.ledger_type", "CONVERT(tinyint, 0)") + " AS ledger_code, "
                + render.Col(14, "t.is_node", "CONVERT(bit, 0)") + " AS node_flag, " + render.Col(14, "t.is_edge", "CONVERT(bit, 0)") + " AS edge_flag, t.is_filetable AS is_filetable, "
                + render.Col(13, "t.is_external", "CONVERT(bit, 0)") + " AS external_flag, " + render.Col(16, "t.is_dropped_ledger_table", "CONVERT(bit, 0)") + " AS dropped_flag, ",
            "view" => render.Col(16, "v.ledger_view_type", "CONVERT(tinyint, 0)") + " AS ledger_view_code, " + render.Col(16, "v.is_dropped_ledger_view", "CONVERT(bit, 0)") + " AS dropped_flag, ",
            _ => ""
        };
        var join = kind switch
        {
            "table" => "JOIN sys.tables AS t ON t.object_id = o.object_id ",
            "view" => "JOIN sys.all_views AS v ON v.object_id = o.object_id ",
            _ => ""
        };
        return "DECLARE @id int = (SELECT o.object_id FROM sys.all_objects AS o JOIN sys.schemas AS s ON s.schema_id = o.schema_id WHERE s.name = @schema AND o.name = @name AND o.type IN ("
            + Types(kind) + "));\n"
            + "SELECT o.object_id AS object_id, o.type AS object_type, o.is_ms_shipped AS is_ms_shipped, " + subtype + "op.name AS owner_name, " + Checks + " "
            + "FROM sys.all_objects AS o JOIN sys.schemas AS s ON s.schema_id = o.schema_id " + join + Owner + "WHERE o.object_id = @id;\n"
            + "SELECT TOP (@take) ps.name AS schema_name, po.name AS object_name, fk.name AS dependent_name FROM sys.foreign_keys AS fk "
            + "JOIN sys.objects AS po ON po.object_id = fk.parent_object_id JOIN sys.schemas AS ps ON ps.schema_id = po.schema_id "
            + "WHERE fk.referenced_object_id = @id AND fk.parent_object_id <> @id ORDER BY ps.name, po.name, fk.name;\n"
            + "SELECT TOP (@take) rs.name AS schema_name, ro.name AS object_name, ro.type AS object_type FROM (SELECT DISTINCT d.referencing_id FROM sys.sql_expression_dependencies AS d "
            + "JOIN sys.sql_modules AS m ON m.object_id = d.referencing_id WHERE d.referenced_id = @id AND d.referencing_id <> @id AND m.is_schema_bound = 1) AS r "
            + "JOIN sys.objects AS ro ON ro.object_id = r.referencing_id JOIN sys.schemas AS rs ON rs.schema_id = ro.schema_id ORDER BY rs.name, ro.name;";
    }

    /// <summary>A database's row in master: state, subtype, what blocks a DROP (replication, an availability group,
    /// mirroring), owner, sessions in it (with VIEW SERVER STATE), permissions and whether @new is another database's name.
    /// The owner falls back to SUSER_SNAME(d.owner_sid): a Windows group's member owns it with no server principal of its own.</summary>
    public const string Database = "SELECT d.database_id AS database_id, d.state AS state, d.state_desc AS state_desc, "
        + "CONVERT(bit, CASE WHEN d.source_database_id IS NULL THEN 0 ELSE 1 END) AS is_snapshot, "
        + "CONVERT(bit, CASE WHEN d.database_id <= 4 OR d.is_distributor = 1 THEN 1 ELSE 0 END) AS is_system, "
        + "CONVERT(bit, CASE WHEN d.is_published = 1 OR d.is_subscribed = 1 OR d.is_merge_published = 1 OR d.is_distributor = 1 THEN 1 ELSE 0 END) AS replicated, "
        + "CONVERT(bit, CASE WHEN d.replica_id IS NULL THEN 0 ELSE 1 END) AS in_availability_group, "
        + "CONVERT(bit, CASE WHEN dm.mirroring_guid IS NULL THEN 0 ELSE 1 END) AS mirrored, "
        + "COALESCE(sp.name, SUSER_SNAME(d.owner_sid)) AS owner_name, "
        + "CASE WHEN HAS_PERMS_BY_NAME(NULL, NULL, N'VIEW SERVER STATE') = 1 THEN (SELECT COUNT(*) FROM sys.dm_exec_sessions AS es WHERE es.database_id = d.database_id) END AS sessions, "
        + "CONVERT(bit, ISNULL(HAS_PERMS_BY_NAME(d.name, N'DATABASE', N'ALTER'), 1)) AS can_alter, "
        + "CONVERT(bit, CASE WHEN ISNULL(HAS_PERMS_BY_NAME(d.name, N'DATABASE', N'CONTROL'), 1) = 1 OR HAS_PERMS_BY_NAME(NULL, NULL, N'ALTER ANY DATABASE') = 1 THEN 1 ELSE 0 END) AS can_drop, "
        + "CONVERT(bit, CASE WHEN EXISTS (SELECT 1 FROM sys.databases AS x WHERE x.name = @new AND x.database_id <> d.database_id) THEN 1 ELSE 0 END) AS name_in_use "
        + "FROM sys.databases AS d LEFT JOIN sys.database_mirroring AS dm ON dm.database_id = d.database_id LEFT JOIN sys.server_principals AS sp ON sp.sid = d.owner_sid "
        + "WHERE d.name = @name;";

    // --- Lint -----------------------------------------------------------------------------------------------------------

    private static readonly HashSet<string> Literals =
    [
        "N'.'", "N'.sys.sp_executesql'", "N'.sys.sp_rename'", "N'OBJECT'", "N'SCHEMA'", "N'DATABASE'", "N'ALTER'", "N'CONTROL'", "N'VIEW SERVER STATE'", "N'ALTER ANY DATABASE'",
        "N'A name could not be quoted.'", "N'DROP TABLE '", "N'DROP VIEW '", "N'DROP PROCEDURE '", "N'DROP FUNCTION '", "N'DROP DATABASE '", "N'ALTER DATABASE '",
        "N' MODIFY NAME = '", "N' SET  SINGLE_USER WITH ROLLBACK IMMEDIATE'",
        // Database Properties' describe and preflight (DatabaseProperties.cs, ActionService.DatabasePropertiesPreflight).
        "N'contained database authentication'", "N'sysadmin'", "N'##%'", "N'SpaceUsed'", "N'@take int'", "N'MAXDOP'", "N'LEGACY_CARDINALITY_ESTIMATION'", "N'PARAMETER_SNIFFING'",
        "N'QUERY_OPTIMIZER_HOTFIXES'", "'FilestreamEffectiveLevel'", "'EngineEdition'", "'ProductMajorVersion'"
    ];
    [GeneratedRegex(@"N?'(?:[^']|'')*'")]
    private static partial Regex LiteralPattern();
    [GeneratedRegex(@"^'[A-Z]{1,2}'$")]
    private static partial Regex TypeLetters();
    [GeneratedRegex(@"@\w+")]
    private static partial Regex Variable();
    [GeneratedRegex(@"DECLARE (@\w+)")]
    private static partial Regex Declared();
    [GeneratedRegex(@"(@\w+) = ")]
    private static partial Regex NamedArgument();
    [GeneratedRegex(@"@p\d+")]
    private static partial Regex Placeholder();
    [GeneratedRegex(@"QUOTENAME\(@p\d+\)|(?<=EXEC [^;]*= )@p\d+(?=[,;])|(?<=SELECT )@p\d+(?= AS )|, @p\d+(?= AS )")]
    private static partial Regex QuotedPlaceholder();
    /// <summary>The one metadata function the catalog statements use, for the owner of a database a Windows group's member made.</summary>
    private const string OwnerFallback = "SUSER_SNAME(d.owner_sid)";

    /// <summary>Problems with one executable batch (empty when it passes): leftover format holes, a name parameter outside
    /// QUOTENAME or a procedure argument, an undeclared variable, and literals beyond the fixed keyword fragments.</summary>
    public static List<string> LintExecutable(string text, ActionTemplate template)
    {
        var problems = new List<string>();
        if (text.Contains('{', StringComparison.Ordinal) || text.Contains('}', StringComparison.Ordinal)) problems.Add("has a format hole");
        var bare = QuotedPlaceholder().Replace(text, "");
        if (Placeholder().IsMatch(bare)) problems.Add("uses a name parameter outside QUOTENAME or a procedure argument");
        var parameters = Enumerable.Range(1, ParameterCount(template)).Select(index => "@p" + index.ToString(CultureInfo.InvariantCulture)).Append("@db").ToHashSet(StringComparer.Ordinal);
        foreach (Match used in Placeholder().Matches(text)) if (!parameters.Contains(used.Value)) problems.Add("uses " + used.Value + ", which the template does not bind");
        problems.AddRange(Undeclared(text, parameters));
        foreach (Match literal in LiteralPattern().Matches(text)) if (!Literals.Contains(literal.Value)) problems.Add("has the literal " + literal.Value);
        return problems;
    }

    /// <summary>Problems with one catalog statement: Object Explorer's metadata-function ban (but the owner fallback),
    /// band gates, names outside parameters, and literals beyond the allowlist.</summary>
    public static List<string> LintCatalog(string text, int band, bool database)
    {
        var problems = new List<string>();
        var stripped = text.Replace(OwnerFallback, "", StringComparison.Ordinal);
        foreach (var builtin in CatalogSql.Builtins) if (stripped.Contains(builtin, StringComparison.OrdinalIgnoreCase)) problems.Add("uses " + builtin);
        if (stripped.Contains("DB_NAME(", StringComparison.OrdinalIgnoreCase) || stripped.Contains("OBJECT_ID(", StringComparison.OrdinalIgnoreCase)) problems.Add("uses a metadata function");
        if (database && text.Contains("HAS_DBACCESS(", StringComparison.OrdinalIgnoreCase)) problems.Add("uses HAS_DBACCESS inside a database");
        foreach (var (token, since) in CatalogSql.Gates) if (band < since && text.Contains(token, StringComparison.Ordinal)) problems.Add("uses " + token + " below band " + since);
        foreach (Match literal in LiteralPattern().Matches(text))
            if (!Literals.Contains(literal.Value) && !TypeLetters().IsMatch(literal.Value)) problems.Add("has the literal " + literal.Value);
        if (database && text.Contains("@db", StringComparison.Ordinal)) problems.Add("names @db inside a statement");
        if (Placeholder().IsMatch(text)) problems.Add("uses a DDL name parameter");
        return problems;
    }

    private static IEnumerable<string> Undeclared(string text, HashSet<string> parameters)
    {
        var declared = Declared().Matches(text).Select(match => match.Groups[1].Value).ToHashSet(StringComparer.Ordinal);
        var arguments = NamedArgument().Matches(text).Where(match => !declared.Contains(match.Groups[1].Value) && match.Index > text.IndexOf("EXEC ", StringComparison.Ordinal)
            && text.IndexOf("EXEC ", StringComparison.Ordinal) >= 0).Select(match => match.Groups[1].Value).ToHashSet(StringComparer.Ordinal);
        foreach (Match used in Variable().Matches(text))
            if (!declared.Contains(used.Value) && !parameters.Contains(used.Value) && !arguments.Contains(used.Value)) yield return "uses the undeclared " + used.Value;
    }

    /// <summary>Every executable and catalog statement, rendered for every band, with its lint problems (ActionChecks).</summary>
    public static IEnumerable<(string Name, List<string> Problems)> Lint()
    {
        foreach (var template in Enum.GetValues<ActionTemplate>())
            foreach (var dry in new[] { false, true })
                yield return (template + (dry ? " (dry run)" : ""), LintExecutable(Executable(template, dry), template));
        for (var band = ExplorerCatalog.MinBand; band <= ExplorerCatalog.MaxBand; band++)
        {
            foreach (var kind in new[] { "table", "view", "procedure", "function" }) yield return (kind + " band " + band, LintCatalog(Object(kind, band), band, database: true));
            yield return ("database band " + band, LintCatalog(Database, band, database: false));
        }
        yield return ("database state", LintCatalog(DatabaseState, ExplorerCatalog.MaxBand, database: false));
        yield return ("module call", LintCatalog(ModuleCall, ExplorerCatalog.MaxBand, database: false));
        // Database Properties: the describe in master and inside the database for every band, its call, the preflight,
        // and every ALTER the catalogue can plan, run and dry run.
        for (var band = ExplorerCatalog.MinBand; band <= ExplorerCatalog.MaxBand; band++)
        {
            yield return ("properties master band " + band, LintCatalog(DatabaseProperties.Master(band), band, database: false));
            yield return ("properties inside band " + band, LintCatalog(DatabaseProperties.Inside(band), band, database: true));
        }
        yield return ("properties call", LintCatalog(DatabaseProperties.InsideCall, ExplorerCatalog.MaxBand, database: false));
        yield return ("properties preflight", LintCatalog(ActionService.DatabasePropertiesPreflight, ExplorerCatalog.MaxBand, database: false));
        foreach (var item in DatabaseAlter.Lint(ActionsCatalog.Current)) yield return item;
    }
}
