using System.Text.RegularExpressions;
using Varia.Backend.Explorer;

namespace Varia.Backend.Ssis;

/// <summary>Everything a statement's text depends on: the server's version band and the catalog's features. Two requests
/// with equal renders run the same text.</summary>
internal readonly record struct SsisRender(int Band, SsisFeatures Features);

/// <summary>Constant SQL for the SSIS Catalog (D-ssis 4.6), run in the catalog's database on the SSIS read pool: values are
/// always parameters, names are never part of the text, and every statement reads. The offline lint (SsisChecks) renders
/// every statement for bands 13 to 17 and every feature set and checks the rules in <see cref="Lint"/>.</summary>
internal static partial class SsisSql
{
    /// <summary>The profile's role checks read as the live reads do (owner decision 4): IS_MEMBER waits on an uncommitted change to
    /// a role's members even under READ UNCOMMITTED (docs/integration-services.md), so they get the short lock timeout.</summary>
    public const string ProfilePrologue = "SET NOCOUNT ON; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED; SET LOCK_TIMEOUT 1000; SET DEADLOCK_PRIORITY LOW;\n";

    /// <summary>Describe reads (D-ssis 4.2): READ COMMITTED when SSISDB runs RCSI (it then reads committed rows without
    /// waiting), otherwise READ UNCOMMITTED, which the catalog's own writes and nightly cleanup cannot block for long.</summary>
    public static string ReadPrologue(bool rcsi) => "SET NOCOUNT ON; SET TRANSACTION ISOLATION LEVEL " + (rcsi ? "READ COMMITTED" : "READ UNCOMMITTED") + "; SET LOCK_TIMEOUT 5000; SET DEADLOCK_PRIORITY LOW;\n";

    /// <summary>The catalog's database state and user access, read on a connection outside it when opening it fails (4060): no
    /// row when it does not exist.</summary>
    public const string CatalogState = "SELECT d.state, d.user_access FROM sys.databases AS d WHERE d.name = @catalog;";

    private static string Has(string table) => "CONVERT(bit, CASE WHEN EXISTS (SELECT 1 FROM sys.objects AS o JOIN sys.schemas AS s ON s.schema_id = o.schema_id "
        + "WHERE s.name = N'catalog' AND o.name = N'" + table + "') THEN 1 ELSE 0 END)";
    private static string HasColumn(string table, string column) => "CONVERT(bit, CASE WHEN EXISTS (SELECT 1 FROM sys.columns AS c JOIN sys.objects AS o ON o.object_id = c.object_id "
        + "JOIN sys.schemas AS s ON s.schema_id = o.schema_id WHERE s.name = N'catalog' AND o.name = N'" + table + "' AND c.name = N'" + column + "') THEN 1 ELSE 0 END)";

    /// <summary>SsisProfile in one batch, in the catalog's database: RCSI, the features (through sys.objects and sys.columns,
    /// never OBJECT_ID or COL_LENGTH, which ignore the lock timeout), and the caller's roles. A sysadmin's IS_MEMBER is never
    /// evaluated, so a pending change to the SSIS roles cannot block it.</summary>
    public static readonly string Profile = "SELECT d.is_read_committed_snapshot_on FROM sys.databases AS d WHERE d.name = @catalog;\n"
        + "SELECT " + Has("customized_logging_levels") + ", " + Has("worker_agents") + ", " + HasColumn("event_messages", "event_message_guid") + ", "
        + HasColumn("executions", "executed_count") + ", " + Has("get_operation_log_size") + ", " + Has("check_schema_version") + ";\n"
        + "SELECT CONVERT(bit, ISNULL(IS_SRVROLEMEMBER(N'sysadmin'), 0)), CONVERT(bit, CASE WHEN IS_SRVROLEMEMBER(N'sysadmin') = 1 THEN 0 ELSE ISNULL(IS_MEMBER(N'ssis_admin'), 0) END), "
        + "CONVERT(bit, CASE WHEN IS_SRVROLEMEMBER(N'sysadmin') = 1 THEN 0 ELSE ISNULL(IS_MEMBER(N'ssis_logreader'), 0) END);";

    /// <summary>What one view reads, as one batch of its statements.</summary>
    public static string Describe(string view, SsisRender render) => string.Join("\n", Statements(view, render).Select(statement => statement.Text));

    /// <summary>One view's statements in order, each marked when it lists rows: the lint holds every such statement to TOP
    /// (@take) and ORDER BY on its own, so one bounded list cannot cover an unbounded one in the same batch. The others read
    /// at most one row: a count, a lookup into a variable, or an object by its key.</summary>
    public static (string Text, bool List)[] Statements(string view, SsisRender render) => view switch
    {
        "catalog" =>
        [
            ("SELECT COUNT_BIG(*) FROM [catalog].[folders] AS f;", false),
            // One character past the bound, so the reader can tell a cut value from one exactly 4,000 characters long.
            ("IF @admin = 1 SELECT TOP (@take) cp.property_name, LEFT(cp.property_value, @chars + 1) FROM [catalog].[catalog_properties] AS cp ORDER BY cp.property_name;", true)
        ],
        "folder" =>
        [
            ("SELECT f.folder_id, f.name, f.description, f.created_by_name, f.created_time, "
                + "(SELECT COUNT_BIG(*) FROM [catalog].[projects] AS p WHERE p.folder_id = f.folder_id), (SELECT COUNT_BIG(*) FROM [catalog].[environments] AS e WHERE e.folder_id = f.folder_id) "
                + "FROM [catalog].[folders] AS f WHERE f.name = @folder;", false)
        ],
        "project" =>
        [
            (ProjectLookup, false),
            ("SELECT p.project_id, f.name, p.name, p.description, p.project_format_version, p.deployed_by_name, p.last_deployed_time, p.created_time, p.object_version_lsn, "
                + "p.validation_status, p.last_validation_time FROM [catalog].[projects] AS p JOIN [catalog].[folders] AS f ON f.folder_id = p.folder_id WHERE p.project_id = @project_id;", false),
            ("SELECT TOP (@take) pk.name, pk.entry_point, pk.description, pk.version_major, pk.version_minor, pk.version_build FROM [catalog].[packages] AS pk "
                + "WHERE pk.project_id = @project_id ORDER BY pk.name;", true),
            (Parameters("20", "@project"), true),
            ("SELECT TOP (@take) r.reference_id, r.reference_type, r.environment_folder_name, r.environment_name, r.validation_status FROM [catalog].[environment_references] AS r "
                + "WHERE r.project_id = @project_id ORDER BY r.reference_id;", true)
        ],
        "package" =>
        [
            (ProjectLookup, false),
            ("SELECT pk.package_id, pk.name, pk.description, pk.package_format_version, pk.version_major, pk.version_minor, pk.version_build, pk.version_comments, pk.entry_point, "
                + "pk.validation_status, pk.last_validation_time FROM [catalog].[packages] AS pk WHERE pk.project_id = @project_id AND pk.name = @name;", false),
            (Parameters("30", "@name"), true)
        ],
        "environment" =>
        [
            ("DECLARE @environment_id bigint;\n"
                + "SELECT @environment_id = e.environment_id FROM [catalog].[environments] AS e JOIN [catalog].[folders] AS f ON f.folder_id = e.folder_id WHERE f.name = @folder AND e.name = @name;", false),
            ("SELECT e.environment_id, f.name, e.name, e.description, e.created_by_name, e.created_time FROM [catalog].[environments] AS e "
                + "JOIN [catalog].[folders] AS f ON f.folder_id = e.folder_id WHERE e.environment_id = @environment_id;", false),
            // The catalog returns no value for a sensitive variable either; the CASE keeps one from ever reaching the answer.
            ("SELECT TOP (@take) v.name, v.type, v.description, v.sensitive, CASE WHEN v.sensitive = 1 THEN NULL ELSE v.value END FROM [catalog].[environment_variables] AS v "
                + "WHERE v.environment_id = @environment_id ORDER BY v.name;", true)
        ],
        _ => throw new InvalidOperationException("Unknown SSIS view " + view + ".")
    };

    /// <summary>The project a project or package describe reads, by folder and project name.</summary>
    private const string ProjectLookup = "DECLARE @project_id bigint;\n"
        + "SELECT @project_id = p.project_id FROM [catalog].[projects] AS p JOIN [catalog].[folders] AS f ON f.folder_id = p.folder_id WHERE f.name = @folder AND p.name = @project;";

    /// <summary>A project's (object type 20) or package's (30) parameters. A sensitive parameter's values are never read.</summary>
    private static string Parameters(string objectType, string objectName) =>
        "SELECT TOP (@take) op.parameter_name, op.data_type, op.required, op.sensitive, op.description, CASE WHEN op.sensitive = 1 THEN NULL ELSE op.design_default_value END, "
        + "CASE WHEN op.sensitive = 1 THEN NULL ELSE op.default_value END, op.value_type, op.value_set, op.referenced_variable_name FROM [catalog].[object_parameters] AS op "
        + "WHERE op.project_id = @project_id AND op.object_type = " + objectType + " AND op.object_name = " + objectName + " ORDER BY op.parameter_name;";

    /// <summary>The names the profile looks up, the roles it checks, and a LIKE filter's wildcard and escape: the only string literals SSIS statements may hold.</summary>
    private static readonly HashSet<string> Literals = ["N'%'", "N'\\'","N'catalog'", "N'customized_logging_levels'", "N'worker_agents'", "N'event_messages'", "N'event_message_guid'", "N'executions'",
        "N'executed_count'", "N'get_operation_log_size'", "N'check_schema_version'", "N'sysadmin'", "N'ssis_admin'", "N'ssis_logreader'"];
    /// <summary>Metadata functions ignore the isolation level and LOCK_TIMEOUT (D-ssis 1.6).</summary>
    private static readonly string[] Builtins = [.. CatalogSql.Builtins, "OBJECT_ID(", "DB_ID(", "DB_NAME(", "COL_LENGTH(", "HAS_DBACCESS(", "HAS_PERMS_BY_NAME(", "SCHEMA_ID(", "TYPE_ID("];
    private static readonly string[] Writes = ["INSERT", "UPDATE", "DELETE", "MERGE", "EXEC", "EXECUTE", "CREATE", "ALTER", "DROP", "TRUNCATE", "GRANT", "DENY", "REVOKE", "INTO", "WAITFOR"];

    [GeneratedRegex(@"N?'(?:[^']|'')*'")]
    private static partial Regex LiteralPattern();
    [GeneratedRegex(@"\b(?:(?:TRY_)?CAST\s*\([^;]*?\bAS\s+(?:small)?datetime|(?:TRY_)?CONVERT\s*\(\s*(?:small)?datetime)\b(?!2|offset)", RegexOptions.IgnoreCase)]
    private static partial Regex DateTimeCast();
    [GeneratedRegex(@"\b[A-Z_]+\b", RegexOptions.IgnoreCase)]
    private static partial Regex Words();

    /// <summary>Problems with one rendered statement; empty when it passes (D-ssis 4.6). <paramref name="list"/>: it lists rows,
    /// so it is TOP (@take)-bounded and ordered.</summary>
    public static List<string> Lint(string text, bool list)
    {
        var problems = new List<string>();
        foreach (var builtin in Builtins) if (text.Contains(builtin, StringComparison.OrdinalIgnoreCase)) problems.Add("uses " + builtin);
        if (DateTimeCast().IsMatch(text)) problems.Add("converts a datetimeoffset to datetime, which drops its offset");
        if (text.Contains("sp_executesql", StringComparison.OrdinalIgnoreCase) || text.Contains("EXEC (", StringComparison.OrdinalIgnoreCase)
            || text.Contains("EXEC(", StringComparison.OrdinalIgnoreCase) || text.Contains("EXEC @", StringComparison.OrdinalIgnoreCase)) problems.Add("runs dynamic SQL");
        if (text.Contains("SYNCHRONIZED", StringComparison.OrdinalIgnoreCase)) problems.Add("names SYNCHRONIZED");
        var unquoted = LiteralPattern().Replace(text, "''");
        foreach (var word in Words().Matches(unquoted).Select(match => match.Value.ToUpperInvariant()).Distinct())
            if (Writes.Contains(word)) problems.Add("is not a read: " + word);
        foreach (Match literal in LiteralPattern().Matches(text))
            if (!Literals.Contains(literal.Value)) problems.Add("has the literal " + literal.Value);
        if (list && (!text.Contains("SELECT TOP (@take) ", StringComparison.Ordinal) || !text.Contains(" ORDER BY ", StringComparison.Ordinal))) problems.Add("is not a TOP (@take) listing");
        return problems;
    }

    /// <summary>Every statement this file renders, for the lint: the profile, the state check, and each view's statements for
    /// each band and feature set.</summary>
    public static IEnumerable<(string Id, string Text, bool List)> All(IEnumerable<string> views)
    {
        yield return ("profile", ProfilePrologue + Profile, false);
        yield return ("catalogState", CatalogState, false);
        foreach (var prologue in new[] { ReadPrologue(false), ReadPrologue(true) }) yield return ("readPrologue", prologue, false);
        foreach (var view in views)
            for (var band = 13; band <= ExplorerCatalog.MaxBand; band++)
                foreach (var features in SsisFeatures.Every())
                    foreach (var (statement, index) in Statements(view, new SsisRender(band, features)).Select((statement, index) => (statement, index)))
                        yield return (view + " " + band + " " + features + " #" + index, statement.Text, statement.List);
    }
}
