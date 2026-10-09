using System.Data;
using System.Globalization;
using System.Text.RegularExpressions;
using Microsoft.Data.SqlClient;
using Varia.Backend.Explorer;

namespace Varia.Backend.Scripting;

/// <summary>An object the preflight found, with what the pipeline and the error messages need: the subtype the backend
/// derived itself, the catalogue row that subtype selects, and for modules whether SMO could read the definition.</summary>
internal sealed record ResolvedTarget(ObjectRefDto Ref, string Database, string Kind, string Subtype, ScriptTargetRow Row, ScriptSubject Subject,
    string? ParentUrnType = null, string? Column = null, bool SqlModule = false, bool? Encrypted = null, bool DefinitionVisible = true, long? DefinitionBytes = null,
    bool? CanViewDefinition = null);

/// <summary>What the preflight concluded: the target, or an error value with no SMO call made.</summary>
internal sealed record PreflightResult(ResolvedTarget? Target, ScriptError? Error, IReadOnlyList<string> Warnings);

/// <summary>One catalog statement per job before anything else runs (spec C3): does the object exist, which subtype is it
/// now, may this verb script it, and can SMO read it. The text is constant per kind and version band, values are
/// parameters, and database objects are reached only through QUOTENAME(@db) + N'.sys.sp_executesql', as Object
/// Explorer reaches them. ScriptingChecks renders every statement for every band through <see cref="Lint"/>.</summary>
internal static partial class ScriptPreflight
{
    public const string Declarations = "@schema sysname, @name sysname, @parent_schema sysname, @parent_name sysname, @take int";
    public const string ModuleCall = "DECLARE @module nvarchar(300) = QUOTENAME(@db) + N'.sys.sp_executesql';\n"
        + "EXEC @module @stmt, @decl, @schema = @schema, @name = @name, @parent_schema = @parent_schema, @parent_name = @parent_name, @take = @take;";
    /// <summary>Scripting reads committed metadata, waits at most 10 s behind another session's DDL, and loses deadlocks.</summary>
    public const string Prologue = "SET NOCOUNT ON; SET TRANSACTION ISOLATION LEVEL READ COMMITTED; SET LOCK_TIMEOUT 10000; SET DEADLOCK_PRIORITY LOW;";
    public const long MaxDefinitionBytes = 8_000_000;

    /// <summary>The kinds whose statement runs at server scope (the rest run in the object's database).</summary>
    private static readonly HashSet<string> ServerKinds = ["database", "login", "serverRole", "credential", "linkedServer", "backupDevice", "serverTrigger", "audit", "serverAuditSpecification"];
    /// <summary>sys.objects types whose definition is T-SQL text SMO must read (CLR modules have none).</summary>
    private static readonly HashSet<string> SqlModuleTypes = ["V", "P", "FN", "IF", "TF", "R", "D", "TR"];

    public static bool ServerScope(string kind) => ServerKinds.Contains(kind);

    // --- Statements -------------------------------------------------------------------------------------------------

    private const string ModuleColumns = "CONVERT(bit, OBJECTPROPERTY({0}.object_id, N'IsEncrypted')) AS is_encrypted, "
        + "CONVERT(bit, CASE WHEN m.definition IS NULL THEN 0 ELSE 1 END) AS has_definition, CONVERT(bigint, DATALENGTH(m.definition)) AS definition_bytes";
    private const string Schema = "JOIN sys.schemas AS s ON s.schema_id = {0}.schema_id WHERE s.name = @schema AND {0}.name = @name";

    private static string Module(string alias) => string.Format(CultureInfo.InvariantCulture, ModuleColumns, alias);
    private static string Schemed(string alias) => string.Format(CultureInfo.InvariantCulture, Schema, alias);
    private static string Types(IEnumerable<string> types) => string.Join(", ", types.Select(type => "'" + type + "'"));

    /// <summary>The preflight statement of a kind for a version band. Every statement returns at most one row whose
    /// columns are read by name (<see cref="Row"/>).</summary>
    public static string Statement(string kind, int band, ScriptingCatalog catalog, string? parentKind = null)
    {
        var render = new SqlRender(band);
        return kind switch
        {
            "table" => "SELECT t.object_id AS object_id, t.is_ms_shipped AS is_ms_shipped, " + render.Col(13, "t.temporal_type", "CONVERT(tinyint, 0)") + " AS temporal_code, "
                + render.Col(16, "t.ledger_type", "CONVERT(tinyint, 0)") + " AS ledger_code, " + render.Col(14, "t.is_node", "CONVERT(bit, 0)") + " AS node_flag, "
                + render.Col(14, "t.is_edge", "CONVERT(bit, 0)") + " AS edge_flag, t.is_filetable AS is_filetable, " + render.Col(13, "t.is_external", "CONVERT(bit, 0)") + " AS external_flag, "
                + render.Col(16, "t.is_dropped_ledger_table", "CONVERT(bit, 0)") + " AS dropped_flag, "
                + "CONVERT(bit, ISNULL(HAS_PERMS_BY_NAME(QUOTENAME(s.name) + N'.' + QUOTENAME(t.name), N'OBJECT', N'VIEW DEFINITION'), 0)) AS can_view_definition "
                + "FROM sys.tables AS t " + Schemed("t") + ";",
            "view" => "SELECT o.object_id AS object_id, o.type AS object_type, o.is_ms_shipped AS is_ms_shipped, " + Module("o") + ", "
                + render.Col(16, "v.ledger_view_type", "CONVERT(tinyint, 0)") + " AS ledger_view_code, " + render.Col(16, "v.is_dropped_ledger_view", "CONVERT(bit, 0)") + " AS dropped_flag "
                + "FROM sys.all_objects AS o LEFT JOIN sys.all_sql_modules AS m ON m.object_id = o.object_id LEFT JOIN sys.views AS v ON v.object_id = o.object_id "
                + Schemed("o") + " AND o.type IN (" + Types(ObjectTypes(kind, catalog)) + ");",
            "procedure" or "function" or "rule" or "default" => "SELECT o.object_id AS object_id, o.type AS object_type, o.is_ms_shipped AS is_ms_shipped, " + Module("o") + " "
                + "FROM sys.all_objects AS o LEFT JOIN sys.all_sql_modules AS m ON m.object_id = o.object_id " + Schemed("o") + " AND o.type IN (" + Types(ObjectTypes(kind, catalog)) + ");",
            "synonym" => "SELECT sn.object_id AS object_id FROM sys.synonyms AS sn " + Schemed("sn") + ";",
            "sequence" => "SELECT sq.object_id AS object_id FROM sys.sequences AS sq " + Schemed("sq") + ";",
            "xmlSchemaCollection" => "SELECT x.xml_collection_id AS object_id FROM sys.xml_schema_collections AS x " + Schemed("x") + ";",
            "securityPolicy" => band >= 13 ? "SELECT sp.object_id AS object_id FROM sys.security_policies AS sp " + Schemed("sp") + ";" : None,
            "type" => "SELECT ty.user_type_id AS object_id, ty.is_assembly_type AS is_assembly_type FROM sys.types AS ty " + Schemed("ty") + " AND ty.is_user_defined = 1 AND ty.is_table_type = 0;",
            "tableType" => "SELECT tt.type_table_object_id AS object_id FROM sys.table_types AS tt " + Schemed("tt") + ";",
            "index" or "key" or "constraint" or "statistic" or "trigger" => Child(kind, band, parentKind ?? throw new InvalidOperationException("A child needs its parent's kind.")),
            "schema" => "SELECT sc.schema_id AS object_id FROM sys.schemas AS sc WHERE sc.name = @name;",
            "user" => "SELECT dp.principal_id AS object_id FROM sys.database_principals AS dp WHERE dp.name = @name AND dp.type IN ('S', 'U', 'G', 'C', 'K', 'E', 'X');",
            "databaseRole" => "SELECT dp.principal_id AS object_id FROM sys.database_principals AS dp WHERE dp.name = @name AND dp.type = 'R';",
            "applicationRole" => "SELECT dp.principal_id AS object_id FROM sys.database_principals AS dp WHERE dp.name = @name AND dp.type = 'A';",
            "databaseTrigger" => "SELECT tr.object_id AS object_id, tr.type AS object_type, tr.is_ms_shipped AS is_ms_shipped, " + Module("tr") + " "
                + "FROM sys.triggers AS tr LEFT JOIN sys.all_sql_modules AS m ON m.object_id = tr.object_id WHERE tr.parent_class = 0 AND tr.name = @name;",
            "databaseAuditSpecification" => "SELECT das.database_specification_id AS object_id FROM sys.database_audit_specifications AS das WHERE das.name = @name;",
            "fullTextCatalog" => "SELECT fc.fulltext_catalog_id AS object_id FROM sys.fulltext_catalogs AS fc WHERE fc.name = @name;",
            "fullTextStoplist" => "SELECT fs.stoplist_id AS object_id FROM sys.fulltext_stoplists AS fs WHERE fs.name = @name;",
            "searchPropertyList" => "SELECT spl.property_list_id AS object_id FROM sys.registered_search_property_lists AS spl WHERE spl.name = @name;",
            "partitionScheme" => "SELECT ps.data_space_id AS object_id FROM sys.partition_schemes AS ps WHERE ps.name = @name;",
            "partitionFunction" => "SELECT pf.function_id AS object_id FROM sys.partition_functions AS pf WHERE pf.name = @name;",
            "planGuide" => "SELECT pg.plan_guide_id AS object_id FROM sys.plan_guides AS pg WHERE pg.name = @name;",
            // A single-user database another session is in makes HAS_DBACCESS wait; SMO then reports why it cannot open it.
            "database" => "SELECT d.database_id AS object_id, d.state AS state, d.state_desc AS state_desc, "
                + "CONVERT(bit, ISNULL(CASE WHEN d.user_access = 1 THEN 1 ELSE HAS_DBACCESS(d.name) END, 0)) AS has_access, "
                + "CONVERT(bit, CASE WHEN d.source_database_id IS NULL THEN 0 ELSE 1 END) AS is_snapshot, "
                + "CONVERT(bit, CASE WHEN d.database_id <= 4 OR d.is_distributor = 1 THEN 1 ELSE 0 END) AS is_system FROM sys.databases AS d WHERE d.name = @name;",
            "login" => "SELECT sp.principal_id AS object_id FROM sys.server_principals AS sp WHERE sp.name = @name AND sp.type IN ('S', 'U', 'G', 'C', 'K', 'E', 'X');",
            "serverRole" => "SELECT sp.principal_id AS object_id FROM sys.server_principals AS sp WHERE sp.name = @name AND sp.type = 'R';",
            "credential" => "SELECT cr.credential_id AS object_id FROM sys.credentials AS cr WHERE cr.name = @name;",
            "linkedServer" => "SELECT sv.server_id AS object_id FROM sys.servers AS sv WHERE sv.is_linked = 1 AND sv.name = @name;",
            "backupDevice" => "SELECT CONVERT(int, 0) AS object_id FROM sys.backup_devices AS bd WHERE bd.name = @name;",
            // Server triggers have no OBJECTPROPERTY: a hidden definition is encrypted or not visible, which one is unknown.
            "serverTrigger" => "SELECT st.object_id AS object_id, st.type AS object_type, st.is_ms_shipped AS is_ms_shipped, CONVERT(bit, NULL) AS is_encrypted, "
                + "CONVERT(bit, CASE WHEN m.definition IS NULL THEN 0 ELSE 1 END) AS has_definition, CONVERT(bigint, DATALENGTH(m.definition)) AS definition_bytes "
                + "FROM sys.server_triggers AS st LEFT JOIN sys.server_sql_modules AS m ON m.object_id = st.object_id WHERE st.name = @name;",
            "audit" => "SELECT au.audit_id AS object_id FROM sys.server_audits AS au WHERE au.name = @name;",
            "serverAuditSpecification" => "SELECT sas.server_specification_id AS object_id FROM sys.server_audit_specifications AS sas WHERE sas.name = @name;",
            _ => throw new InvalidOperationException("No preflight for " + kind)
        };
    }

    /// <summary>A statement that finds nothing, for a kind a server's band cannot have.</summary>
    private const string None = "SELECT CONVERT(int, NULL) AS object_id WHERE 1 = 0 AND @name IS NOT NULL;";

    /// <summary>The catalogue's object types for a module kind; procedures also look up extended and replication-filter
    /// procedures, whose deferred subtypes the derivation then refuses (they share the System Stored Procedures folder).</summary>
    public static IReadOnlyList<string> ObjectTypes(string kind, ScriptingCatalog catalog) =>
        [.. catalog.Targets.Where(row => row.Kind == kind).SelectMany(row => row.ObjectTypes).Distinct()];

    private static string Child(string kind, int band, string parentKind)
    {
        var parentTypes = parentKind switch { "table" => "'U'", "view" => "'V'", _ => throw new InvalidOperationException("Unknown parent kind " + parentKind) };
        var parent = "DECLARE @parent int = (SELECT po.object_id FROM sys.all_objects AS po JOIN sys.schemas AS ps ON ps.schema_id = po.schema_id "
            + "WHERE ps.name = @parent_schema AND po.name = @parent_name AND po.type IN (" + parentTypes + "));\n";
        return parent + kind switch
        {
            "index" => "SELECT i.index_id AS object_id, i.type AS index_type FROM sys.indexes AS i WHERE i.object_id = @parent AND i.name = @name;",
            "statistic" => "SELECT st.stats_id AS object_id FROM sys.stats AS st WHERE st.object_id = @parent AND st.name = @name;",
            "key" => "SELECT k.type AS object_type FROM (SELECT kc.name, kc.type FROM sys.key_constraints AS kc WHERE kc.parent_object_id = @parent "
                + "UNION ALL SELECT fk.name, fk.type FROM sys.foreign_keys AS fk WHERE fk.parent_object_id = @parent) AS k WHERE k.name = @name;",
            "constraint" => "SELECT k.type AS object_type, k.column_name AS column_name FROM (SELECT cc.name, cc.type, CONVERT(sysname, NULL) AS column_name FROM sys.check_constraints AS cc "
                + "WHERE cc.parent_object_id = @parent UNION ALL SELECT dc.name, dc.type, c.name FROM sys.default_constraints AS dc JOIN sys.all_columns AS c "
                + "ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id WHERE dc.parent_object_id = @parent"
                + (band >= 15 ? " UNION ALL SELECT ec.name, ec.type, NULL FROM sys.edge_constraints AS ec WHERE ec.parent_object_id = @parent" : "") + ") AS k WHERE k.name = @name;",
            "trigger" => "SELECT tr.object_id AS object_id, tr.type AS object_type, tr.is_ms_shipped AS is_ms_shipped, " + Module("tr") + " "
                + "FROM sys.triggers AS tr LEFT JOIN sys.all_sql_modules AS m ON m.object_id = tr.object_id WHERE tr.parent_id = @parent AND tr.name = @name;",
            _ => throw new InvalidOperationException("Not a child kind: " + kind)
        };
    }

    // --- Lint -------------------------------------------------------------------------------------------------------

    private static readonly HashSet<string> Literals = ["N'IsEncrypted'", "N'OBJECT'", "N'VIEW DEFINITION'", "N'.'", "N'.sys.sp_executesql'"];
    [GeneratedRegex(@"N?'(?:[^']|'')*'")]
    private static partial Regex LiteralPattern();
    [GeneratedRegex(@"^'[A-Z]{1,4}'$")]
    private static partial Regex TypeLetters();
    [GeneratedRegex(@"OBJECTPROPERTY\((\w+)\.object_id, N'IsEncrypted'\)")]
    private static partial Regex EncryptedCall();

    /// <summary>Problems with one rendered statement (empty when it passes): Object Explorer's metadata-function ban,
    /// except OBJECTPROPERTY(…, N'IsEncrypted'), which nothing else answers; band gates; literals beyond the allowlist.</summary>
    public static List<string> Lint(string text, int band, bool serverScope)
    {
        var problems = new List<string>();
        var stripped = EncryptedCall().Replace(text, "");
        foreach (var builtin in CatalogSql.Builtins) if (stripped.Contains(builtin, StringComparison.OrdinalIgnoreCase)) problems.Add("uses " + builtin);
        if (!serverScope && text.Contains("HAS_DBACCESS(", StringComparison.OrdinalIgnoreCase)) problems.Add("uses HAS_DBACCESS inside a database");
        foreach (var (token, since) in CatalogSql.Gates) if (band < since && text.Contains(token, StringComparison.Ordinal)) problems.Add("uses " + token + " below band " + since);
        foreach (Match literal in LiteralPattern().Matches(text))
            if (!Literals.Contains(literal.Value) && !TypeLetters().IsMatch(literal.Value)) problems.Add("has the literal " + literal.Value);
        if (text.Contains("@db", StringComparison.Ordinal)) problems.Add("names @db inside a statement");
        if (!text.Contains("@name", StringComparison.Ordinal)) problems.Add("does not look the object up by @name");
        return problems;
    }

    // --- Run --------------------------------------------------------------------------------------------------------

    /// <summary>Runs the kind's statement on the job's connection and decides (spec C3 outcomes, in order).</summary>
    /// <param name="perDatabase">The connection is already in the object's database (cloud editions): no scope wrapper.</param>
    /// <param name="delay">ScriptingOptions.PreflightDelay: the cancellation checks hold the statement in WAITFOR.</param>
    public static async Task<PreflightResult> RunAsync(SqlConnection connection, ScriptingCatalog catalog, ObjectRefDto target, ScriptVerbRow verb, int band, bool perDatabase,
        TimeSpan? delay, CancellationToken token)
    {
        var kind = target.Kind;
        var server = ServerScope(kind);
        var database = server ? "master" : target.Database!;
        var subject = Subject(catalog, target, verb, database);
        var statement = (delay is { } wait ? "WAITFOR DELAY '" + wait.ToString(@"hh\:mm\:ss\.fff", CultureInfo.InvariantCulture) + "';\n" : "")
            + Statement(kind, band, catalog, target.Parent?.Kind);
        await using var command = connection.CreateCommand();
        command.CommandTimeout = 30;
        var wrapped = !server && !perDatabase;
        if (wrapped)
        {
            command.CommandText = ModuleCall;
            Add(command, "@db", SqlDbType.NVarChar, 128, target.Database);
            Add(command, "@stmt", SqlDbType.NVarChar, -1, statement);
            Add(command, "@decl", SqlDbType.NVarChar, -1, Declarations);
        }
        else command.CommandText = statement;
        Add(command, "@schema", SqlDbType.NVarChar, 128, target.Schema);
        Add(command, "@name", SqlDbType.NVarChar, 128, target.Name);
        Add(command, "@parent_schema", SqlDbType.NVarChar, 128, target.Parent?.Schema);
        Add(command, "@parent_name", SqlDbType.NVarChar, 128, target.Parent?.Name);
        Add(command, "@take", SqlDbType.Int, 0, 0);
        Dictionary<string, object?>? row = null;
        try
        {
            await using var reader = await command.ExecuteReaderAsync(token);
            if (await reader.ReadAsync(token))
            {
                row = new(StringComparer.Ordinal);
                for (var i = 0; i < reader.FieldCount; i++) row[reader.GetName(i)] = reader.IsDBNull(i) ? null : reader.GetValue(i);
            }
        }
        // Inside EXEC [db].sys.sp_executesql, a missing procedure can only be the wrapper's: the database is gone.
        catch (SqlException error) when (wrapped && error.Number is 2812 or 911 && !token.IsCancellationRequested)
        {
            return new(null, ScriptingErrors.Create(catalog, "NOT_FOUND", subject), []);
        }
        return Decide(catalog, target, verb, subject, database, row is null ? null : new Row(row));
    }

    public static ScriptSubject Subject(ScriptingCatalog catalog, ObjectRefDto target, ScriptVerbRow verb, string? database)
    {
        var title = catalog.Targets.FirstOrDefault(row => row.Kind == target.Kind && row.Scriptable) is { } row && catalog.Titles.TryGetValue(row.Title, out var noun) ? noun : target.Kind;
        var name = target.Schema is { } schema ? schema + "." + target.Name : target.Name ?? target.Kind;
        return new(ScriptingErrors.Display(name), title, verb.Name, database);
    }

    /// <summary>A preflight row's columns by name; a column a statement does not return reads as its default.</summary>
    internal sealed class Row(IReadOnlyDictionary<string, object?> values)
    {
        public int Int(string name) => values.TryGetValue(name, out var value) && value is not null ? Convert.ToInt32(value, CultureInfo.InvariantCulture) : 0;
        public long? Long(string name) => values.TryGetValue(name, out var value) && value is not null ? Convert.ToInt64(value, CultureInfo.InvariantCulture) : null;
        public bool Bool(string name) => values.TryGetValue(name, out var value) && value is not null && Convert.ToBoolean(value, CultureInfo.InvariantCulture);
        public bool? NullableBool(string name) => values.TryGetValue(name, out var value) && value is not null ? Convert.ToBoolean(value, CultureInfo.InvariantCulture) : null;
        public string? Text(string name) => values.TryGetValue(name, out var value) && value is not null ? Convert.ToString(value, CultureInfo.InvariantCulture)?.Trim() : null;
        public bool Has(string name) => values.ContainsKey(name);
    }

    /// <summary>The subtype Object Explorer would show for this row now (PR4's derivations), or '' for none.</summary>
    public static string Subtype(string kind, Row row) => kind switch
    {
        "table" => ExplorerLabels.TableSubtype(row.Int("temporal_code"), row.Int("ledger_code"), row.Bool("node_flag"), row.Bool("edge_flag"), row.Bool("is_filetable"),
            row.Bool("external_flag"), row.Bool("dropped_flag"), row.Bool("is_ms_shipped")) ?? "",
        "view" => row.Bool("dropped_flag") ? "droppedLedger" : row.Int("ledger_view_code") == 1 ? "ledger" : row.Bool("is_ms_shipped") ? "system" : "",
        "procedure" => row.Text("object_type") switch
        {
            "X" => "extended",
            "RF" => "replicationFilter",
            var type => row.Bool("is_ms_shipped") ? "system" : ExplorerLabels.ProcedureSubtype(type ?? "P")
        },
        "function" => ExplorerLabels.FunctionSubtype(row.Text("object_type") ?? "FN"),
        "database" => row.Bool("is_snapshot") ? "snapshot" : row.Bool("is_system") ? "system" : "",
        "type" => row.Bool("is_assembly_type") ? "clr" : "alias",
        "key" => row.Text("object_type") switch { "PK" => "primary", "UQ" => "unique", _ => "foreign" },
        "constraint" => row.Text("object_type") switch { "D" => "default", "EC" => "edge", _ => "check" },
        "index" => ExplorerLabels.IndexSubtype(row.Int("index_type")),
        _ => ""
    };

    private static PreflightResult Decide(ScriptingCatalog catalog, ObjectRefDto target, ScriptVerbRow verb, ScriptSubject subject, string database, Row? row)
    {
        if (row is null) return new(null, ScriptingErrors.Create(catalog, "NOT_FOUND", subject), []);
        var kind = target.Kind;
        var subtype = Subtype(kind, row);
        var catalogRow = catalog.Row(kind, subtype) ?? catalog.Row(kind, "");
        if (catalogRow is not { Scriptable: true } || !catalogRow.Enabled.Contains(verb.Id) || catalogRow.Parents.Count > 0 && !catalogRow.Parents.Contains(target.Parent?.Kind ?? ""))
            return new(null, ScriptingErrors.Create(catalog, "NOT_SUPPORTED", subject), []);
        if (kind == "database" && verb.Verb is ScriptVerb.Create or ScriptVerb.Alter)
        {
            var state = row.Int("state");
            if (state is not (0 or 5)) return new(null, ScriptingErrors.Create(catalog, "DATABASE_UNAVAILABLE", subject with { Database = target.Name }, row.Text("state_desc") ?? "offline"), []);
            if (!row.Bool("has_access")) return new(null, ScriptingErrors.Create(catalog, "DATABASE_UNAVAILABLE", subject with { Database = target.Name }, "no access"), []);
        }
        var sqlModule = row.Text("object_type") is { } type && SqlModuleTypes.Contains(type) && row.Has("has_definition");
        var encrypted = row.NullableBool("is_encrypted");
        var visible = !sqlModule || row.Bool("has_definition");
        var bytes = row.Long("definition_bytes");
        var resolved = new ResolvedTarget(target, database, kind, subtype, catalogRow, subject, target.Parent?.Kind switch { "table" => "Table", "view" => "View", _ => null },
            row.Text("column_name"), sqlModule, encrypted, visible, bytes, row.Has("can_view_definition") ? row.Bool("can_view_definition") : null);
        // SMO reads a module's definition for every verb that writes its body.
        if (sqlModule && verb.Verb is ScriptVerb.Create or ScriptVerb.Alter or ScriptVerb.CreateOrAlter or ScriptVerb.DropAndCreate)
        {
            if (encrypted == true) return new(null, ScriptingErrors.Create(catalog, "ENCRYPTED", subject), []);
            if (!visible) return new(null, ScriptingErrors.Create(catalog, "NO_DEFINITION", subject, kind == "serverTrigger" ? "server" : null), []);
            if (bytes > MaxDefinitionBytes) return new(null, ScriptingErrors.Create(catalog, "TOO_LARGE", subject, "definition"), []);
        }
        var warnings = new List<string>();
        if (kind == "table" && resolved.CanViewDefinition == false)
            warnings.Add("You do not have VIEW DEFINITION permission on " + subject.Display + "; parts you cannot see (for example indexes or constraints) may be missing from the script.");
        return new(resolved, null, warnings);
    }

    private static void Add(SqlCommand command, string name, SqlDbType type, int size, object? value)
    {
        var parameter = size == 0 ? new SqlParameter(name, type) : new SqlParameter(name, type, size);
        parameter.Value = value ?? DBNull.Value;
        command.Parameters.Add(parameter);
    }
}
