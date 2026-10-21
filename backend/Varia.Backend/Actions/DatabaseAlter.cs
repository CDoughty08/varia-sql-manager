using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using Varia.Backend.Explorer;
using Varia.Backend.Scripting;

namespace Varia.Backend.Actions;

/// <summary>Database Properties' statements: SMO's ALTER DATABASE … SET forms, COMPATIBILITY_LEVEL, COLLATE,
/// AUTO_CREATE_STATISTICS, FILESTREAM, the scoped configurations, SSMS's SetSnapshotIsolation and the owner.</summary>
internal enum AlterTemplate { Set, Compat, Collate, AutoCreateStats, Filestream, Scoped, SnapshotIsolation, Owner }

/// <summary>One planned statement: its template, the database it changes, the option key and token it writes (from the
/// embedded catalogue only), a range-checked number, a name (a collation or a login, verbatim), whether the SET options
/// close other connections (WITH ROLLBACK IMMEDIATE), and the step's title.</summary>
internal sealed record AlterStatement(AlterTemplate Template, string Database, string Key, string? Token = null, long? Number = null, string? Name = null, bool Rollback = false, string Title = "")
{
    /// <summary>Where it runs: ALTER DATABASE in master, scoped configurations and the owner in the database (SMO's USE [db]).</summary>
    public bool InDatabase => Template is AlterTemplate.Scoped or AlterTemplate.Owner;
}

/// <summary>A piece of a statement: constant keyword text, the database's name, a number, the collation or the login.</summary>
internal readonly record struct AlterPart(char Kind, string Text = "")
{
    public static AlterPart Literal(string text) => new('L', text);
    public static readonly AlterPart Database = new('D'), Number = new('N'), Collation = new('C'), Login = new('O');
}

/// <summary>Validates, plans and renders Database Properties' changes (spec PR-B §3.7 and §4.2). Every statement is a
/// list of parts from the embedded catalogue: Script renders them as SSMS writes them (C#'s QUOTENAME), and the batch
/// that runs them has SQL Server build the same text from constant keyword literals, QUOTENAME'd name parameters, a
/// CONVERT of a range-checked number, and a collation only as sys.fn_helpcollations() names it.</summary>
internal static partial class DatabaseAlter
{
    private static string NL => ScriptFormatter.NewLine;
    private static RequestException Invalid(string detail) => new("INVALID_PARAMS", "Invalid object action request: " + detail);
    private static readonly Regex Integer = IntegerPattern();
    // \z, not $: $ also matches before a final line break, which database.ts' patterns refuse.
    [GeneratedRegex(@"^(0|[1-9][0-9]{0,10})\z")]
    private static partial Regex IntegerPattern();
    [GeneratedRegex(@"^[A-Za-z0-9_]{1,128}\z")]
    private static partial Regex CollationPattern();

    /// <summary>The catalogue entry of an option or scoped configuration key, or null.</summary>
    public static OptionJson? Option(ActionsCatalog catalog, string key) =>
        catalog.DatabaseOptions.TryGetValue(key, out var option) ? option : catalog.ScopedConfigurations.GetValueOrDefault(key);

    /// <summary>Whether <paramref name="token"/> is a value of the option, as src/shared/actions/database.ts' tokenProblem decides.</summary>
    public static bool TokenValid(OptionJson option, string token)
    {
        if (option.Key == "collation") return CollationPattern().IsMatch(token);
        if (option.Tokens?.Contains(token) == true) return true;
        return option.Range is { } range && Integer.IsMatch(token) && long.Parse(token, CultureInfo.InvariantCulture) is var value && value >= range.Min && value <= range.Max;
    }

    /// <summary>Re-validates the properties request as zod does: a database target, verbatim names, known settable keys with
    /// their own tokens, at least one change and at most the catalogue's statements, and closeConnections only with a change
    /// SSMS closes connections for. Messages never echo values.</summary>
    public static void Validate(ActionsCatalog catalog, ActionArgs args)
    {
        if (args.NewName is not null || args.DeleteHistory is not null) throw Invalid("properties takes no new name or delete options.");
        if (args.CloseConnections is not { } close || args.Changes is not { } changes) throw Invalid("closeConnections and changes are required.");
        if (args.Target.Kind != "database") throw Invalid("only a database has properties.");
        if (changes.Owner is not null && !ExplorerRefs.Ident(changes.Owner)) throw Invalid("owner.");
        void Check(Dictionary<string, string>? values, IReadOnlyDictionary<string, OptionJson> options, string what)
        {
            foreach (var (key, token) in values ?? [])
                if (!options.TryGetValue(key, out var option) || !option.Settable || token is not { Length: >= 1 and <= 128 } || !TokenValid(option, token)) throw Invalid(what + ".");
        }
        Check(changes.Options, catalog.DatabaseOptions, "options");
        Check(changes.Scoped, catalog.ScopedConfigurations, "scoped configurations");
        var count = (changes.Options?.Count ?? 0) + (changes.Scoped?.Count ?? 0) + (changes.Owner is null ? 0 : 1);
        if (count == 0) throw Invalid("there is nothing to change.");
        if (count > catalog.Limit("statements")) throw Invalid("too many changes.");
        if (close && !(changes.Options ?? []).Keys.Any(key => catalog.DatabaseOptions[key].Exclusive == true)) throw Invalid("no change needs other connections closed.");
    }

    /// <summary>What the preflight read about the database: its version band, the server's highest compatibility level, and
    /// whether Auto Create Statistics is on now (SMO writes INCREMENTAL only when it ends up on).</summary>
    public sealed record Facts(int Band, int MaxCompatibility, bool AutoCreateStatistics);

    /// <summary>The statements in SSMS's order (SMO's ScriptAlter order, the scoped configurations, SetSnapshotIsolation,
    /// SetOwner), or the reason SQL Server would refuse them.</summary>
    public static (List<AlterStatement>? Plan, string? Refusal) Plan(ActionsCatalog catalog, string database, DatabaseChangesDto changes, bool rollback, Facts facts)
    {
        var system = new[] { "master", "model", "msdb", "tempdb" }.FirstOrDefault(name => name == database);
        var plan = new List<(int Order, AlterStatement Statement)>();
        var options = changes.Options ?? [];
        foreach (var (key, token) in options.Concat(changes.Scoped ?? []))
        {
            var option = Option(catalog, key)!;
            if (option.Since is { } since && facts.Band < since) return (null, option.Label + " needs a newer version of SQL Server.");
            if (system is not null && option.NotOn?.Contains(system) == true) return (null, "SQL Server does not allow changing " + option.Label + " on " + system + ".");
            var sql = option.Sql!;
            switch (sql.Kind)
            {
                case "set":
                    plan.Add((option.SmoOrder, new(AlterTemplate.Set, database, key, sql.Seconds == true ? null : token, sql.Seconds == true ? long.Parse(token, CultureInfo.InvariantCulture) : null,
                        Rollback: rollback, Title: option.Label)));
                    break;
                case "compat":
                    var level = int.Parse(token, CultureInfo.InvariantCulture);
                    if (level > facts.MaxCompatibility) return (null, "This server does not offer compatibility level " + level + ".");
                    plan.Add((option.SmoOrder, new(AlterTemplate.Compat, database, key, Number: level, Title: option.Label)));
                    break;
                case "collate":
                    plan.Add((option.SmoOrder, new(AlterTemplate.Collate, database, key, Name: token, Title: option.Label)));
                    break;
                case "filestream":
                    plan.Add((option.SmoOrder, new(AlterTemplate.Filestream, database, key, token, Rollback: rollback, Title: option.Label)));
                    break;
                case "snapshotIsolation":
                    plan.Add((option.SmoOrder, new(AlterTemplate.SnapshotIsolation, database, key, token, Title: option.Label)));
                    break;
                case "scoped":
                    plan.Add((option.SmoOrder, Integer.IsMatch(token)
                        ? new(AlterTemplate.Scoped, database, key, Number: long.Parse(token, CultureInfo.InvariantCulture), Title: option.Label)
                        : new(AlterTemplate.Scoped, database, key, token, Title: option.Label)));
                    break;
                case "autoCreateStats":
                    break;
                default:
                    throw new InvalidOperationException("Unknown option form " + sql.Kind);
            }
        }
        // SMO's ScriptAutoCreateStatistics: ON or OFF when Auto Create Statistics changed, and (INCREMENTAL = …) only when it ends up on.
        var create = options.GetValueOrDefault("autoCreateStatistics");
        var incremental = options.GetValueOrDefault("autoCreateIncrementalStatistics");
        var on = create is null ? facts.AutoCreateStatistics : create == "true";
        var fragment = (create is null ? "" : create == "true" ? "ON" : "OFF") + (incremental is not null && on ? (create is null ? "ON" : "") + "(INCREMENTAL = " + (incremental == "true" ? "ON" : "OFF") + ")" : "");
        if (fragment.Length > 0) plan.Add((catalog.DatabaseOptions["autoCreateStatistics"].SmoOrder, new(AlterTemplate.AutoCreateStats, database, "autoCreateStatistics", fragment,
            Title: catalog.DatabaseOptions[create is null ? "autoCreateIncrementalStatistics" : "autoCreateStatistics"].Label)));
        if (changes.Owner is { } owner)
        {
            if (system is not null && catalog.OwnerNotOn.Contains(system)) return (null, "SQL Server does not allow changing the owner of " + system + ".");
            plan.Add((int.MaxValue, new(AlterTemplate.Owner, database, "owner", Name: owner, Title: "Owner")));
        }
        // SSMS would run READ_ONLY and then fail what SQL Server refuses on a read-only database (3906), leaving the database
        // read-only with those changes failed; nothing runs instead, as the dialog's own check says.
        if (options.GetValueOrDefault("readOnly") == "true")
        {
            var readOnly = catalog.DatabaseOptions["readOnly"].SmoOrder;
            var refused = plan.Where(item => item.Order > readOnly && (item.Statement.Template == AlterTemplate.Owner || Option(catalog, item.Statement.Key)?.RefusedReadOnly == true))
                .OrderBy(item => item.Order).Select(item => item.Statement.Title).FirstOrDefault();
            if (refused is not null) return (null, AfterReadOnlyProblem(refused));
        }
        return ([.. plan.OrderBy(item => item.Order).Select(item => item.Statement)], null);
    }

    /// <summary>src/shared/actions/database.ts' afterReadOnlyProblem, word for word.</summary>
    public static string AfterReadOnlyProblem(string label) => label + " cannot change in the same OK as setting Database Read-Only to True: SQL Server refuses it once the database is read-only.";

    /// <summary>The fragments AUTO_CREATE_STATISTICS can take (SMO's ScriptAutoCreateStatistics).</summary>
    public static readonly string[] AutoCreateFragments = ["ON", "OFF", "ON(INCREMENTAL = ON)", "ON(INCREMENTAL = OFF)"];
    private static string Termination(bool rollback) => rollback ? "WITH ROLLBACK IMMEDIATE" : "WITH NO_WAIT";

    /// <summary>The statement as parts. Keyword text comes only from the catalogue; a token it does not list throws.</summary>
    public static List<AlterPart> Parts(ActionsCatalog catalog, AlterStatement statement)
    {
        var option = statement.Template == AlterTemplate.Owner ? null : Option(catalog, statement.Key) ?? throw new InvalidOperationException("Unknown option " + statement.Key);
        var sql = option?.Sql;
        string Token(Dictionary<string, string>? tokens) => tokens is not null && statement.Token is { } token && tokens.TryGetValue(token, out var text) ? text : throw new InvalidOperationException("Unknown token");
        var alter = AlterPart.Literal("ALTER DATABASE ");
        return statement.Template switch
        {
            AlterTemplate.Set when sql!.Seconds == true =>
                [alter, AlterPart.Database, AlterPart.Literal(" SET " + sql.Keyword + " " + (sql.Eq == true ? "= " : "")), AlterPart.Number, AlterPart.Literal(" SECONDS " + Termination(statement.Rollback))],
            // SMO's "ALTER DATABASE {0} SET {1} {2}{3} {4}": an empty keyword or a value with a trailing space doubles a space.
            AlterTemplate.Set => [alter, AlterPart.Database, AlterPart.Literal(" SET " + sql!.Keyword + " " + (sql.Eq == true ? "= " : "") + Token(sql.Tokens) + " " + Termination(statement.Rollback))],
            AlterTemplate.Compat => [alter, AlterPart.Database, AlterPart.Literal(" SET COMPATIBILITY_LEVEL = "), AlterPart.Number],
            AlterTemplate.Collate => [alter, AlterPart.Database, AlterPart.Literal(" COLLATE "), AlterPart.Collation],
            AlterTemplate.AutoCreateStats => AutoCreateFragments.Contains(statement.Token)
                ? [alter, AlterPart.Database, AlterPart.Literal(" SET AUTO_CREATE_STATISTICS " + statement.Token)] : throw new InvalidOperationException("Unknown fragment"),
            AlterTemplate.Filestream => statement.Token is { } token && option!.Tokens?.Contains(token) == true
                ? [alter, AlterPart.Database, AlterPart.Literal(" SET FILESTREAM( NON_TRANSACTED_ACCESS = " + statement.Token + " ) " + Termination(statement.Rollback))] : throw new InvalidOperationException("Unknown token"),
            AlterTemplate.SnapshotIsolation => statement.Token is "true" or "false"
                ? [alter, AlterPart.Database, AlterPart.Literal(" SET ALLOW_SNAPSHOT_ISOLATION " + (statement.Token == "true" ? "ON" : "OFF"))] : throw new InvalidOperationException("Unknown token"),
            AlterTemplate.Scoped => statement.Number is not null
                ? [AlterPart.Literal("ALTER DATABASE SCOPED CONFIGURATION " + (sql!.Secondary == true ? "FOR SECONDARY " : "") + "SET " + sql.Name + " = "), AlterPart.Number, AlterPart.Literal(";")]
                : statement.Token is { } token && option!.Tokens?.Contains(token) == true
                    ? [AlterPart.Literal("ALTER DATABASE SCOPED CONFIGURATION " + (sql!.Secondary == true ? "FOR SECONDARY " : "") + "SET " + sql.Name + " = " + (sql.Tokens is null ? token : Token(sql.Tokens)) + ";")]
                    : throw new InvalidOperationException("Unknown token"),
            AlterTemplate.Owner => [AlterPart.Literal("ALTER AUTHORIZATION ON DATABASE::"), AlterPart.Database, AlterPart.Literal(" TO "), AlterPart.Login],
            _ => throw new InvalidOperationException("Unknown template " + statement.Template)
        };
    }

    /// <summary>The bounds a statement's number is checked against, in C# and again by the batch.</summary>
    public static (long Min, long Max) NumberRange(ActionsCatalog catalog, AlterStatement statement) => statement.Template == AlterTemplate.Compat
        ? (catalog.CompatibilityLevels.Min(), catalog.CompatibilityLevels.Max())
        : Option(catalog, statement.Key)?.Range is { } range ? (range.Min, range.Max) : throw new InvalidOperationException("No range for " + statement.Key);

    /// <summary>The statement as SSMS writes it, names quoted by C#'s QUOTENAME.</summary>
    public static string Statement(ActionsCatalog catalog, AlterStatement statement) => string.Concat(Parts(catalog, statement).Select(part => part.Kind switch
    {
        'L' => part.Text,
        'D' => ScriptFormatter.Quote(statement.Database),
        'N' => statement.Number!.Value.ToString(CultureInfo.InvariantCulture),
        'C' => statement.Name!,
        'O' => ScriptFormatter.Quote(statement.Name!),
        _ => throw new InvalidOperationException("Unknown part")
    }));

    /// <summary>SSMS's script: SMO's Database.Alter batches under USE [master], the scoped configurations under USE [db],
    /// SetSnapshotIsolation's statement where it stands, and SetOwner's USE [db] and ALTER AUTHORIZATION; GO after each.</summary>
    public static string ScriptText(ActionsCatalog catalog, IReadOnlyList<AlterStatement> plan)
    {
        var text = new StringBuilder();
        string? context = null;
        void Use(string database) { text.Append("USE ").Append(ScriptFormatter.Quote(database)).Append(NL).Append("GO").Append(NL); context = database; }
        foreach (var statement in plan)
        {
            if (statement.Template == AlterTemplate.Owner) Use(statement.Database);
            else if (statement.InDatabase && context != statement.Database) Use(statement.Database);
            else if (!statement.InDatabase && statement.Template != AlterTemplate.SnapshotIsolation && context != "master") Use("master");
            text.Append(Statement(catalog, statement)).Append(NL).Append("GO").Append(NL);
        }
        return text.ToString();
    }

    private static string Sql(string literal) => "N'" + literal.Replace("'", "''", StringComparison.Ordinal) + "'";

    /// <summary>The batch that runs a statement: SQL Server builds it from constant literals and the parameters (@db where it
    /// runs, @p1 the database, @p2 the collation or login, @n1 the number), in master or, through QUOTENAME(@db)'s
    /// sp_executesql, the database. <paramref name="dryRun"/> (the live checks only, never the wire) selects it instead.</summary>
    public static string Executable(ActionsCatalog catalog, AlterStatement statement, bool dryRun = false)
    {
        var parts = Parts(catalog, statement);
        var text = new StringBuilder();
        if (parts.Contains(AlterPart.Number))
        {
            var (min, max) = NumberRange(catalog, statement);
            text.Append("IF @n1 IS NULL OR @n1 < ").Append(min.ToString(CultureInfo.InvariantCulture)).Append(" OR @n1 > ").Append(max.ToString(CultureInfo.InvariantCulture))
                .Append(" THROW 50000, N'A number is out of range.', 1;\n");
        }
        if (parts.Contains(AlterPart.Collation))
            text.Append("DECLARE @c sysname = (SELECT c.name FROM sys.fn_helpcollations() AS c WHERE c.name = @p2);\nIF @c IS NULL THROW 50000, N'The collation is not one of the server''s.', 1;\n");
        text.Append("DECLARE @stmt nvarchar(max) = ").Append(string.Join(" + ", parts.Select(part => part.Kind switch
        {
            'L' => Sql(part.Text),
            'D' => "QUOTENAME(@p1)",
            'N' => "CONVERT(nvarchar(20), @n1)",
            'C' => "@c",
            'O' => "QUOTENAME(@p2)",
            _ => throw new InvalidOperationException("Unknown part")
        }))).Append(";\n").Append(ActionSql.Guard);
        text.Append(dryRun ? "SELECT @stmt AS stmt;" : "DECLARE @module nvarchar(300) = QUOTENAME(@db) + N'.sys.sp_executesql';\nEXEC @module @stmt;");
        return text.ToString();
    }

    // --- Lint -----------------------------------------------------------------------------------------------------------

    /// <summary>The fixed messages and module suffix its batches may hold besides keyword text (ActionSql.LintExecutable).</summary>
    public static readonly IReadOnlySet<string> Messages = new HashSet<string>(StringComparer.Ordinal)
        { "N'A name could not be quoted.'", "N'A number is out of range.'", "N'The collation is not one of the server''s.'", "N'.sys.sp_executesql'" };

    /// <summary>Every statement the catalogue can plan: each settable option with each of its tokens (a number at its bounds),
    /// both terminations, the auto-create fragments, scoped configurations and the owner.</summary>
    public static IEnumerable<AlterStatement> Corpus(ActionsCatalog catalog, string database = "db", string name = "Latin1_General_CI_AS")
    {
        foreach (var option in catalog.DatabaseOptions.Values.Concat(catalog.ScopedConfigurations.Values).Where(option => option.Settable))
        {
            var sql = option.Sql!;
            foreach (var rollback in new[] { false, true })
            {
                switch (sql.Kind)
                {
                    case "set" when sql.Seconds == true:
                        yield return new(AlterTemplate.Set, database, option.Key, Number: option.Range!.Max, Rollback: rollback);
                        break;
                    case "set":
                        foreach (var token in sql.Tokens!.Keys) yield return new(AlterTemplate.Set, database, option.Key, token, Rollback: rollback);
                        break;
                    case "filestream":
                        foreach (var token in option.Tokens!) yield return new(AlterTemplate.Filestream, database, option.Key, token, Rollback: rollback);
                        break;
                }
            }
            switch (sql.Kind)
            {
                case "compat":
                    foreach (var level in catalog.CompatibilityLevels) yield return new(AlterTemplate.Compat, database, option.Key, Number: level);
                    break;
                case "collate":
                    yield return new(AlterTemplate.Collate, database, option.Key, Name: name);
                    break;
                case "snapshotIsolation":
                    foreach (var token in option.Tokens!) yield return new(AlterTemplate.SnapshotIsolation, database, option.Key, token);
                    break;
                case "scoped":
                    foreach (var token in option.Tokens ?? []) yield return new(AlterTemplate.Scoped, database, option.Key, token);
                    if (option.Range is { } range) { yield return new(AlterTemplate.Scoped, database, option.Key, Number: range.Min); yield return new(AlterTemplate.Scoped, database, option.Key, Number: range.Max); }
                    break;
            }
        }
        foreach (var fragment in AutoCreateFragments) yield return new(AlterTemplate.AutoCreateStats, database, "autoCreateStatistics", fragment);
        yield return new(AlterTemplate.Owner, database, "owner", Name: name);
    }

    /// <summary>Every batch of the corpus, run and dry run, with its lint problems (DatabasePropertiesChecks).</summary>
    public static IEnumerable<(string Name, List<string> Problems)> Lint(ActionsCatalog catalog)
    {
        foreach (var statement in Corpus(catalog))
            foreach (var dry in new[] { false, true })
                yield return (statement.Template + " " + statement.Key + " " + statement.Token + (statement.Rollback ? " rollback" : "") + (dry ? " (dry run)" : ""),
                    ActionSql.LintExecutable(Executable(catalog, statement, dry), Messages));
    }
}
