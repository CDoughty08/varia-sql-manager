using System.Text;
using System.Text.RegularExpressions;
using Varia.Backend.Explorer;
using Varia.Backend.Scripting;

namespace Varia.Backend.Actions;

/// <summary>Table Properties' statements: ALTER TABLE … SET (LOCK_ESCALATION = …), ENABLE CHANGE_TRACKING WITH (TRACK_COLUMNS_UPDATED =
/// …) and DISABLE CHANGE_TRACKING, and the table's extended properties through sp_addextendedproperty, sp_updateextendedproperty and
/// sp_dropextendedproperty.</summary>
internal enum TableTemplate { LockEscalation, EnableTracking, DisableTracking, AddProperty, UpdateProperty, DropProperty }

/// <summary>One planned statement: its template, the table (database, schema, name), the keyword token it writes (a lock escalation
/// from the embedded catalogue, or ON or OFF for Track columns updated), an extended property's name and value, and the step's title.</summary>
internal sealed record TableStatement(TableTemplate Template, string Database, string Schema, string Table, string? Token = null, string? Name = null, string? Value = null, string Title = "")
{
    /// <summary>An extended property procedure, whose arguments are the names and the value themselves, never text.</summary>
    public bool Procedure => Template is TableTemplate.AddProperty or TableTemplate.UpdateProperty or TableTemplate.DropProperty;
}

/// <summary>Validates, plans and renders Table Properties' changes. An ALTER TABLE is a builder batch (ActionSql.LintExecutable's
/// form 2): SQL Server builds it from constant keyword literals and the QUOTENAME'd schema (@p1) and table (@p2), and runs it in the
/// database through QUOTENAME(@db)'s sp_executesql. An extended property is the database's own procedure, called through
/// QUOTENAME(@db), with the schema, table and property names (@p1, @p2, @p3) and the value (@v1, nvarchar(4000), which SQL Server
/// converts to sql_variant) as its arguments (<see cref="LintProcedure"/>). Script renders each as SSMS writes it, in one transaction.</summary>
internal static partial class TableAlter
{
    private static string NL => ScriptFormatter.NewLine;
    private static RequestException Invalid(string detail) => new("INVALID_PARAMS", "Invalid object action request: " + detail);

    /// <summary>Re-validates the tableProperties request as zod does (src/shared/actions/schema.ts tablePropertiesIssues): only the
    /// table's changes and identity, a lock escalation of the catalogue, Track columns updated only with change tracking on, extended
    /// property names verbatim and each once, a value exactly for an add or an update (text of at most the catalogue's bound, without NUL
    /// or an unpaired surrogate), and between one and the catalogue's statements. Messages never echo values.</summary>
    public static void Validate(ActionsCatalog catalog, ActionArgs args)
    {
        if (args.NewName is not null || args.CloseConnections is not null || args.DeleteHistory is not null || args.Changes is not null || args.Design is not null || args.Databases is not null)
            throw Invalid("tableProperties takes only tableChanges and an identity.");
        if (args.TableChanges is not { } changes) throw Invalid("tableChanges is required.");
        if (args.Identity is { } identity && !DatabaseAlter.IdentityValid(identity)) throw Invalid("identity.");
        var tables = catalog.Tables;
        if (changes.LockEscalation is { } token && !tables.LockEscalation.Contains(token)) throw Invalid("lockEscalation.");
        if (changes.ChangeTracking is { Enabled: false, TrackColumnsUpdated: not null }) throw Invalid("trackColumnsUpdated goes only with change tracking on.");
        var properties = changes.ExtendedProperties ?? [];
        if (properties.Count > tables.Limit("extendedPropertyChanges")) throw Invalid("too many extended properties.");
        var limit = tables.Limit("extendedPropertyValue");
        foreach (var change in properties)
        {
            if (change is null || !tables.ExtendedPropertyOps.Contains(change.Op) || !ExplorerRefs.Ident(change.Name)) throw Invalid("extendedProperties.");
            if ((change.Op == "drop") != (change.Value is null)) throw Invalid("an add or an update writes a value; a drop writes none.");
            if (change.Value is { } value && (value.Length > limit || value.Contains('\0') || ScriptingErrors.UnpairedSurrogate(value) >= 0)) throw Invalid("extendedProperties.value.");
        }
        if (properties.Select(change => change.Name).Distinct(StringComparer.Ordinal).Count() != properties.Count) throw Invalid("an extended property changes twice.");
        var count = (changes.LockEscalation is null ? 0 : 1) + (changes.ChangeTracking is null ? 0 : 2) + properties.Count;
        if (count == 0) throw Invalid("there is nothing to change.");
        if (count > catalog.Limit("statements")) throw Invalid("too many changes.");
    }

    /// <summary>The statements, in order: lock escalation, change tracking (off and on again when only Track columns updated changes),
    /// then the extended properties dropped, changed and added; or the reason nothing may run. A change the table already has plans
    /// nothing.</summary>
    public static (List<TableStatement>? Plan, string? Refusal) Plan(ActionsCatalog catalog, string database, string schema, string table, TableChangesDto changes, TableProperties.Facts facts)
    {
        var tables = catalog.Tables;
        if (facts.System) return (null, tables.Message("systemTable"));
        if (facts.External) return (null, tables.Message("externalTable"));
        if (facts.DroppedLedger) return (null, tables.Message("droppedLedger"));
        var plan = new List<TableStatement>();
        TableStatement Statement(TableTemplate template, string step, string? token = null, string? name = null, string? value = null) =>
            new(template, database, schema, table, token, name, value, tables.Step(step));
        if (changes.LockEscalation is { } escalation)
        {
            if (facts.MemoryOptimized) return (null, tables.Message("memoryOptimized"));
            if (escalation != facts.LockEscalation) plan.Add(Statement(TableTemplate.LockEscalation, "lockEscalation", escalation));
        }
        if (changes.ChangeTracking is { } tracking)
        {
            var before = plan.Count;
            var columns = tracking.TrackColumnsUpdated ?? (facts.Tracking && facts.TrackColumns);
            if (tracking.Enabled && !facts.Tracking)
            {
                // Before the primary key: adding one would not help a memory-optimized table.
                if (facts.MemoryOptimized) return (null, tables.Message("trackingMemoryOptimized"));
                if (!facts.PrimaryKey) return (null, tables.Message("primaryKey"));
                plan.Add(Statement(TableTemplate.EnableTracking, "enableTracking", columns ? "ON" : "OFF"));
            }
            else if (tracking.Enabled && columns != facts.TrackColumns)
            {
                // SQL Server changes TRACK_COLUMNS_UPDATED only by turning change tracking off and on again (SSMS does the same).
                plan.Add(Statement(TableTemplate.DisableTracking, "disableTracking"));
                plan.Add(Statement(TableTemplate.EnableTracking, "enableTracking", columns ? "ON" : "OFF"));
            }
            else if (!tracking.Enabled && facts.Tracking) plan.Add(Statement(TableTemplate.DisableTracking, "disableTracking"));
            // Refused only when it would change something: a request for the state the table has plans nothing, and says so.
            if (plan.Count > before && facts.MemoryOptimized) return (null, tables.Message("trackingMemoryOptimized"));
        }
        foreach (var op in new[] { "drop", "update", "add" })
            foreach (var change in (changes.ExtendedProperties ?? []).Where(change => change.Op == op))
                plan.Add(Statement(op switch { "drop" => TableTemplate.DropProperty, "update" => TableTemplate.UpdateProperty, _ => TableTemplate.AddProperty }, op, name: change.Name, value: change.Value));
        return plan.Count == 0 ? (null, tables.Message("nothingToChange")) : (plan, null);
    }

    /// <summary>Apply's recheck, the transaction's first step: why the table read again (<paramref name="now"/>; null when it is gone)
    /// may not take the plan made from <paramref name="read"/>'s facts: another table, or one changed so the plan differs. Null when
    /// it may. TableStatement is a record, so equal plans are the same statements, values and titles.</summary>
    public static (string Code, string Message)? Recheck(ActionsCatalog catalog, string database, string schema, string table, TableChangesDto changes, TableProperties.Facts read,
        IReadOnlyList<TableStatement> plan, TableProperties.Facts? now)
    {
        if (now is null) return ("NOT_FOUND", "gone");
        if (now.Id != read.Id || now.Created != read.Created) return ("NOT_FOUND", catalog.Tables.Message("notTheTable"));
        var (again, _) = Plan(catalog, database, schema, table, changes, now);
        return again is null || !again.SequenceEqual(plan) ? ("NOT_SUPPORTED", catalog.Tables.Message("changed")) : null;
    }

    /// <summary>Whether the database must track changes before the plan runs: it turns a table's change tracking on.</summary>
    public static bool NeedsDatabaseTracking(IReadOnlyList<TableStatement> plan) => plan.Any(statement => statement.Template == TableTemplate.EnableTracking);

    /// <summary>The keyword text after the table's name. Tokens come only from the catalogue (lock escalation) or are ON and OFF.</summary>
    private static string Keyword(ActionsCatalog catalog, TableStatement statement) => statement.Template switch
    {
        TableTemplate.LockEscalation => statement.Token is { } token && catalog.Tables.LockEscalation.Contains(token) ? " SET (LOCK_ESCALATION = " + token + ")" : throw new InvalidOperationException("Unknown token"),
        TableTemplate.EnableTracking => statement.Token is "ON" or "OFF" ? " ENABLE CHANGE_TRACKING WITH (TRACK_COLUMNS_UPDATED = " + statement.Token + ")" : throw new InvalidOperationException("Unknown token"),
        TableTemplate.DisableTracking => " DISABLE CHANGE_TRACKING",
        _ => throw new InvalidOperationException("Not an ALTER TABLE: " + statement.Template)
    };

    private static string ProcedureName(TableTemplate template) => template switch
    {
        TableTemplate.AddProperty => "sp_addextendedproperty",
        TableTemplate.UpdateProperty => "sp_updateextendedproperty",
        TableTemplate.DropProperty => "sp_dropextendedproperty",
        _ => throw new InvalidOperationException("Not a procedure: " + template)
    };

    private static string Literal(string value) => "N'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";

    /// <summary>The statement as SSMS writes it, names quoted by C#'s QUOTENAME and values as N'' literals.</summary>
    public static string Statement(ActionsCatalog catalog, TableStatement statement)
    {
        if (!statement.Procedure) return "ALTER TABLE " + ScriptFormatter.Quote(statement.Schema) + "." + ScriptFormatter.Quote(statement.Table) + Keyword(catalog, statement);
        var value = statement.Template == TableTemplate.DropProperty ? "" : ", @value = " + Literal(statement.Value ?? "");
        return "EXEC sys." + ProcedureName(statement.Template) + " @name = " + Literal(statement.Name!) + value + ", @level0type = N'SCHEMA', @level0name = " + Literal(statement.Schema)
            + ", @level1type = N'TABLE', @level1name = " + Literal(statement.Table);
    }

    /// <summary>Script: the statements in one transaction in the table's database, as Apply runs them.</summary>
    public static string ScriptText(ActionsCatalog catalog, IReadOnlyList<TableStatement> plan)
    {
        if (plan.Count == 0 || plan.Any(statement => statement.Database != plan[0].Database)) throw new InvalidOperationException("A transaction's statements run in one database.");
        var text = new StringBuilder("USE ").Append(ScriptFormatter.Quote(plan[0].Database)).Append(NL).Append("GO").Append(NL).Append("SET XACT_ABORT ON;").Append(NL).Append("BEGIN TRANSACTION;").Append(NL);
        foreach (var statement in plan) text.Append(Statement(catalog, statement)).Append(';').Append(NL);
        return text.Append("COMMIT TRANSACTION;").Append(NL).Append("GO").Append(NL).ToString();
    }

    private const string ProcedureGuard = "IF @proc IS NULL THROW 50000, N'A name could not be quoted.', 1;\n";

    /// <summary>The batch that runs a statement, with @db (the database), @p1 (the schema), @p2 (the table) and, for a procedure, @p3
    /// (the property's name) and @v1 (its value). <paramref name="dryRun"/> (the live checks only, never the wire) selects an ALTER's text
    /// instead of running it.</summary>
    public static string Executable(ActionsCatalog catalog, TableStatement statement, bool dryRun = false)
    {
        if (statement.Procedure)
        {
            if (dryRun) throw new InvalidOperationException("A procedure has no dry run.");
            var value = statement.Template == TableTemplate.DropProperty ? "" : ", @value = @v1";
            return "DECLARE @proc nvarchar(300) = QUOTENAME(@db) + " + Literal(".sys." + ProcedureName(statement.Template)) + ";\n" + ProcedureGuard
                + "EXEC @proc @name = @p3" + value + ", @level0type = N'SCHEMA', @level0name = @p1, @level1type = N'TABLE', @level1name = @p2;";
        }
        return "DECLARE @stmt nvarchar(max) = N'ALTER TABLE ' + QUOTENAME(@p1) + N'.' + QUOTENAME(@p2) + " + Literal(Keyword(catalog, statement)) + ";\n" + ActionSql.Guard
            + (dryRun ? "SELECT @stmt AS stmt;" : "DECLARE @module nvarchar(300) = QUOTENAME(@db) + N'.sys.sp_executesql';\nEXEC @module @stmt;");
    }

    // --- Lint -----------------------------------------------------------------------------------------------------------

    /// <summary>The fixed literals an ALTER's builder batch may hold besides keyword text (ActionSql.LintExecutable's form 2).</summary>
    public static readonly IReadOnlySet<string> Messages = new HashSet<string>(StringComparer.Ordinal) { "N'A name could not be quoted.'", "N'.sys.sp_executesql'", "N'.'" };

    /// <summary>The literals a procedure batch may hold: its module suffixes, the level types and the guard's message.</summary>
    private static readonly HashSet<string> ProcedureLiterals = new(StringComparer.Ordinal)
    {
        "N'.sys.sp_addextendedproperty'", "N'.sys.sp_updateextendedproperty'", "N'.sys.sp_dropextendedproperty'", "N'SCHEMA'", "N'TABLE'", "N'A name could not be quoted.'"
    };
    [GeneratedRegex(@"N?'(?:[^']|'')*'")]
    private static partial Regex LiteralPattern();
    [GeneratedRegex(@"@\w+")]
    private static partial Regex Variable();
    /// <summary>Where a procedure batch may use its parameters: @db only in QUOTENAME, the names and the value only as the callee's arguments.</summary>
    [GeneratedRegex(@"QUOTENAME\(@db\)|@(?:name|value|level0type|level0name|level1type|level1name) = @(?:p[123]|v1)(?=[,;])|@(?:level0type|level1type) = ")]
    private static partial Regex ProcedureUse();

    /// <summary>Problems with one procedure batch (empty when it passes): a format hole, a secret, a parameter outside QUOTENAME(@db) or
    /// a callee argument, a variable other than @proc, no quoting guard, and a literal that is not one of <see cref="ProcedureLiterals"/>.</summary>
    public static List<string> LintProcedure(string text)
    {
        var problems = new List<string>();
        if (text.Contains('{', StringComparison.Ordinal) || text.Contains('}', StringComparison.Ordinal)) problems.Add("has a format hole");
        problems.AddRange(CatalogSql.SecretUses(text));
        foreach (Match used in Variable().Matches(ProcedureUse().Replace(text, "")))
            if (used.Value != "@proc") problems.Add("uses " + used.Value + " outside QUOTENAME or a procedure argument");
        if (!text.Contains(ProcedureGuard, StringComparison.Ordinal)) problems.Add("has no quoting guard");
        if (!text.Contains("EXEC @proc ", StringComparison.Ordinal)) problems.Add("calls no procedure through @proc");
        foreach (Match literal in LiteralPattern().Matches(text)) if (!ProcedureLiterals.Contains(literal.Value)) problems.Add("has the literal " + literal.Value);
        return problems;
    }

    /// <summary>Every statement the catalogue can plan, with hostile names (a quote, a bracket and a line break, which only parameters carry).</summary>
    public static IEnumerable<TableStatement> Corpus(ActionsCatalog catalog)
    {
        const string database = "d]'b", schema = "s'[c", table = "t]\nb";
        foreach (var token in catalog.Tables.LockEscalation) yield return new(TableTemplate.LockEscalation, database, schema, table, token);
        foreach (var token in new[] { "ON", "OFF" }) yield return new(TableTemplate.EnableTracking, database, schema, table, token);
        yield return new(TableTemplate.DisableTracking, database, schema, table);
        yield return new(TableTemplate.AddProperty, database, schema, table, Name: "MS_Description", Value: "it's");
        yield return new(TableTemplate.UpdateProperty, database, schema, table, Name: "MS_Description", Value: "it's");
        yield return new(TableTemplate.DropProperty, database, schema, table, Name: "MS_Description");
    }

    /// <summary>Every batch of the corpus (an ALTER run and dry run), with its lint problems; and the reads (TableProperties) for every band.</summary>
    public static IEnumerable<(string Name, List<string> Problems)> Lint(ActionsCatalog catalog)
    {
        foreach (var statement in Corpus(catalog))
        {
            if (statement.Procedure) { yield return ("table " + statement.Template, LintProcedure(Executable(catalog, statement))); continue; }
            foreach (var dry in new[] { false, true })
                yield return ("table " + statement.Template + " " + statement.Token + (dry ? " (dry run)" : ""), ActionSql.LintExecutable(Executable(catalog, statement, dry), Messages));
        }
        yield return ("table properties master", ActionSql.LintCatalog(TableProperties.Master, ExplorerCatalog.MaxBand, database: false));
        for (var band = ExplorerCatalog.MinBand; band <= ExplorerCatalog.MaxBand; band++)
        {
            yield return ("table properties inside band " + band, ActionSql.LintCatalog(TableProperties.Inside(band, catalog.Tables), band, database: true));
            yield return ("table properties preflight band " + band, ActionSql.LintCatalog(TableProperties.Preflight(band), band, database: true));
        }
    }
}
