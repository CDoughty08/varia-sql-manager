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
    bool? CanViewDefinition = null, string? ObjectType = null, IReadOnlyList<ColumnRow>? Columns = null, IReadOnlyList<ParameterRow>? Parameters = null,
    string? Identity = null, string? Provider = null);

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
    public static readonly TimeSpan LockTimeout = TimeSpan.FromSeconds(10);
    public const long MaxDefinitionBytes = 8_000_000;

    /// <summary>The definitions SMO reads besides the target's own when Script triggers or Generate script for dependent
    /// objects is on: the modules @objects names and, where t = 1, the triggers on them. Names arrive as hex UTF-16, so
    /// control characters and unpaired surrogates survive the XML. The first module that is encrypted or longer than @max
    /// bytes comes back, so SMO never loads it (spec F).</summary>
    public const string DefinitionCheck = "DECLARE @list xml = CONVERT(xml, @objects);\n"
        + "SELECT TOP (1) q.schema_name, q.object_name, q.parent_name, CONVERT(bit, ISNULL(q.is_encrypted, 0)) AS is_encrypted FROM (SELECT "
        + "CONVERT(sysname, CONVERT(varbinary(256), l.o.value('@s', 'varchar(512)'), 2)) AS s, CONVERT(sysname, CONVERT(varbinary(256), l.o.value('@n', 'varchar(512)'), 2)) AS n, "
        + "l.o.value('@t', 'bit') AS t FROM @list.nodes('/d/o') AS l(o)) AS w "
        + "JOIN sys.schemas AS sc ON sc.name = w.s JOIN sys.all_objects AS ob ON ob.schema_id = sc.schema_id AND ob.name = w.n "
        + "CROSS APPLY (SELECT sc.name, ob.name, CONVERT(sysname, NULL), OBJECTPROPERTY(ob.object_id, N'IsEncrypted'), DATALENGTH(m.definition) FROM sys.all_sql_modules AS m "
        + "WHERE m.object_id = ob.object_id UNION ALL SELECT sc.name, tr.name, ob.name, OBJECTPROPERTY(tr.object_id, N'IsEncrypted'), DATALENGTH(tm.definition) "
        + "FROM sys.triggers AS tr JOIN sys.all_sql_modules AS tm ON tm.object_id = tr.object_id WHERE w.t = 1 AND tr.parent_id = ob.object_id) "
        + "AS q(schema_name, object_name, parent_name, is_encrypted, bytes) WHERE q.is_encrypted = 1 OR q.bytes > @max ORDER BY q.is_encrypted DESC;";
    public const string DefinitionCall = "DECLARE @module nvarchar(300) = QUOTENAME(@db) + N'.sys.sp_executesql';\n"
        + "EXEC @module @stmt, N'@objects nvarchar(max), @max bigint', @objects = @objects, @max = @max;";

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

    /// <summary>The preflight statement of a kind for a version band and verb class. Every statement returns at most one
    /// row whose columns are read by name (<see cref="Row"/>); a template verb's statement then returns the rows its
    /// template lists (<see cref="Rowset"/>).</summary>
    /// <param name="vector">The server has sys.all_columns.vector_dimensions (ServerProfile.VectorDimensions).</param>
    public static string Statement(string kind, int band, ScriptingCatalog catalog, string? parentKind = null, VerbClass verbs = VerbClass.Ddl, bool vector = false) =>
        Lookup(kind, band, catalog, parentKind, verbs) + (Rowset(kind, verbs) switch
        {
            RowsetKind.Columns => "\n" + ObjectId(kind, catalog) + ColumnRows(new SqlRender(band, vector)),
            RowsetKind.Parameters => "\n" + ObjectId(kind, catalog) + ParameterRows,
            _ => ""
        });

    /// <summary>Whether the login may see a table's whole definition, for the DDL verbs' warning. Database-wide VIEW
    /// DEFINITION (also implied by db_owner, sysadmin and VIEW ANY DEFINITION) is checked first: the object-level check
    /// waits out LOCK_TIMEOUT behind another session's schema lock (a TRUNCATE, an index rebuild) and then reads as 0.</summary>
    private const string CanViewDefinition = "CONVERT(bit, CASE WHEN HAS_PERMS_BY_NAME(NULL, N'DATABASE', N'VIEW DEFINITION') = 1 THEN 1 "
        + "ELSE ISNULL(HAS_PERMS_BY_NAME(QUOTENAME(s.name) + N'.' + QUOTENAME(t.name), N'OBJECT', N'VIEW DEFINITION'), 0) END) AS can_view_definition ";

    private static string Lookup(string kind, int band, ScriptingCatalog catalog, string? parentKind, VerbClass verbs)
    {
        var render = new SqlRender(band);
        return kind switch
        {
            "table" => "SELECT t.object_id AS object_id, t.is_ms_shipped AS is_ms_shipped, " + render.Col(13, "t.temporal_type", "CONVERT(tinyint, 0)") + " AS temporal_code, "
                + render.Col(16, "t.ledger_type", "CONVERT(tinyint, 0)") + " AS ledger_code, " + render.Col(14, "t.is_node", "CONVERT(bit, 0)") + " AS node_flag, "
                + render.Col(14, "t.is_edge", "CONVERT(bit, 0)") + " AS edge_flag, t.is_filetable AS is_filetable, " + render.Col(13, "t.is_external", "CONVERT(bit, 0)") + " AS external_flag, "
                + render.Col(16, "t.is_dropped_ledger_table", "CONVERT(bit, 0)") + " AS dropped_flag"
                // A template lists only the columns a login with SELECT already sees.
                + (verbs == VerbClass.Ddl ? ", " + CanViewDefinition : " ")
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
            // SMO cannot script credentials; SmoScriptRunner writes them from these columns (no catalog view holds the secret).
            "credential" => "SELECT cr.credential_id AS object_id, cr.credential_identity AS credential_identity, cp.name AS provider_name FROM sys.credentials AS cr "
                + "LEFT JOIN sys.cryptographic_providers AS cp ON cp.provider_id = cr.target_id WHERE cr.name = @name;",
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

    /// <summary>The rows a template verb's preflight also reads: a table's or view's columns for SELECT, INSERT, UPDATE and
    /// DELETE; a procedure's or function's parameters for EXECUTE and a function's SELECT.</summary>
    public enum RowsetKind { None, Columns, Parameters }

    public static RowsetKind Rowset(string kind, VerbClass verbs) => (kind, verbs) switch
    {
        (_, VerbClass.Ddl) => RowsetKind.None,
        ("table" or "view", VerbClass.Dml) => RowsetKind.Columns,
        ("procedure" or "function", _) => RowsetKind.Parameters,
        _ => RowsetKind.None
    };

    /// <summary>The object the rowset belongs to, found as its lookup row found it.</summary>
    private static string ObjectId(string kind, ScriptingCatalog catalog) => "DECLARE @id int = (SELECT o.object_id FROM sys.all_objects AS o " + Schemed("o")
        + " AND o.type IN (" + Types(kind == "table" ? ["U", "ET"] : ObjectTypes(kind, catalog)) + "));\n";

    // Aliases avoid the band-gated column names (the lint looks for them) and reserved words such as precision.
    private static string ColumnRows(SqlRender render) => "SELECT TOP (@take) c.column_id AS column_id, c.name AS column_name, ty.name AS type_name, tys.name AS type_schema, "
        + "ty.is_user_defined AS is_user_defined, c.max_length AS max_length, c.precision AS type_precision, c.scale AS type_scale, c.is_identity AS is_identity, "
        + "c.is_computed AS is_computed, c.is_sparse AS is_sparse, c.is_column_set AS is_column_set, c.system_type_id AS system_type_id, "
        + render.Col(13, "c.generated_always_type", "CONVERT(tinyint, 0)") + " AS generated_code, " + render.Col(13, "c.is_hidden", "CONVERT(bit, 0)") + " AS hidden_flag, "
        + render.Col(14, "c.graph_type", "CONVERT(int, NULL)") + " AS graph_code, " + render.Col(16, "c.is_dropped_ledger_column", "CONVERT(bit, 0)") + " AS dropped_flag, "
        + (render.VectorDimensions ? "c.vector_dimensions" : "CONVERT(int, NULL)") + " AS vector_size, xss.name AS xml_schema, xs.name AS xml_collection "
        + "FROM sys.all_columns AS c JOIN sys.types AS ty ON ty.user_type_id = c.user_type_id JOIN sys.schemas AS tys ON tys.schema_id = ty.schema_id "
        + "LEFT JOIN sys.xml_schema_collections AS xs ON c.xml_collection_id <> 0 AND xs.xml_collection_id = c.xml_collection_id "
        + "LEFT JOIN sys.schemas AS xss ON xss.schema_id = xs.schema_id WHERE c.object_id = @id ORDER BY c.column_id;";

    private const string ParameterRows = "SELECT TOP (@take) p.parameter_id AS parameter_id, p.name AS parameter_name, p.is_output AS is_output, p.is_readonly AS is_readonly, "
        + "p.is_cursor_ref AS is_cursor_ref, ty.name AS type_name, tys.name AS type_schema, ty.is_user_defined AS is_user_defined, p.max_length AS max_length, "
        + "p.precision AS type_precision, p.scale AS type_scale, xss.name AS xml_schema, xs.name AS xml_collection "
        + "FROM sys.all_parameters AS p JOIN sys.types AS ty ON ty.user_type_id = p.user_type_id JOIN sys.schemas AS tys ON tys.schema_id = ty.schema_id "
        + "LEFT JOIN sys.xml_schema_collections AS xs ON p.xml_collection_id <> 0 AND xs.xml_collection_id = p.xml_collection_id "
        + "LEFT JOIN sys.schemas AS xss ON xss.schema_id = xs.schema_id WHERE p.object_id = @id ORDER BY p.parameter_id;";

    /// <summary>The rows a rowset reads at most: one past its limit, which then means TOO_LARGE. Parameters also hold a
    /// scalar function's return value.</summary>
    public static int Take(RowsetKind rowset, ScriptingCatalog catalog) => rowset switch
    {
        RowsetKind.Columns => (int)catalog.Limit("maxColumns") + 1,
        RowsetKind.Parameters => (int)catalog.Limit("maxParameters") + 2,
        _ => 0
    };

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

    private static readonly HashSet<string> Literals = ["N'IsEncrypted'", "N'OBJECT'", "N'DATABASE'", "N'VIEW DEFINITION'", "N'.'", "N'.sys.sp_executesql'"];
    [GeneratedRegex(@"N?'(?:[^']|'')*'")]
    private static partial Regex LiteralPattern();
    [GeneratedRegex(@"^'[A-Z]{1,4}'$")]
    private static partial Regex TypeLetters();
    [GeneratedRegex(@"OBJECTPROPERTY\((\w+)\.object_id, N'IsEncrypted'\)")]
    private static partial Regex EncryptedCall();

    /// <summary>Problems with one rendered statement (empty when it passes): Object Explorer's metadata-function ban,
    /// except OBJECTPROPERTY(…, N'IsEncrypted'), which nothing else answers; band gates; literals beyond the allowlist.</summary>
    public static List<string> Lint(string text, int band, bool serverScope, bool vector = false)
    {
        var problems = new List<string>();
        if (!vector && text.Contains("vector_dimensions", StringComparison.Ordinal)) problems.Add("uses vector_dimensions without the probe flag");
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
        TimeSpan? delay, CancellationToken token, bool vector = false)
    {
        var kind = target.Kind;
        var server = ServerScope(kind);
        var database = server ? "master" : target.Database!;
        var subject = Subject(catalog, target, verb, database);
        var rowset = Rowset(kind, verb.Class);
        var statement = (delay is { } wait ? "WAITFOR DELAY '" + wait.ToString(@"hh\:mm\:ss\.fff", CultureInfo.InvariantCulture) + "';\n" : "")
            + Statement(kind, band, catalog, target.Parent?.Kind, verb.Class, vector);
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
        Add(command, "@take", SqlDbType.Int, 0, Take(rowset, catalog));
        Row? row = null;
        var rows = new List<Row>();
        var watch = System.Diagnostics.Stopwatch.StartNew();
        try
        {
            await using var reader = await command.ExecuteReaderAsync(token);
            if (await reader.ReadAsync(token)) row = Read(reader);
            if (rowset != RowsetKind.None && await reader.NextResultAsync(token))
                while (await reader.ReadAsync(token)) rows.Add(Read(reader));
        }
        // Inside EXEC [db].sys.sp_executesql, a missing procedure can only be the wrapper's: the database is gone.
        catch (SqlException error) when (wrapped && error.Number is 2812 or 911 && !token.IsCancellationRequested)
        {
            return new(null, ScriptingErrors.Create(catalog, "NOT_FOUND", subject), []);
        }
        return Decide(catalog, target, verb, subject, database, row, rowset, rows, waited: watch.Elapsed - (delay ?? TimeSpan.Zero) >= LockTimeout);
    }

    private static Row Read(SqlDataReader reader)
    {
        var values = new Dictionary<string, object?>(reader.FieldCount, StringComparer.Ordinal);
        for (var i = 0; i < reader.FieldCount; i++) values[reader.GetName(i)] = reader.IsDBNull(i) ? null : reader.GetValue(i);
        return new Row(values);
    }

    private static TypeRow TypeOf(Row row) => new(row.Text("type_name") ?? "", row.Text("type_schema"), row.Bool("is_user_defined"), row.Int("max_length"), row.Int("type_precision"),
        row.Int("type_scale"), row.Text("xml_schema"), row.Text("xml_collection"), row.Long("vector_size") is { } size ? (int)size : null, row.Bool("is_cursor_ref"));

    /// <summary>A column of the rowset; names keep their spaces (Text trims, which a name must not lose).</summary>
    public static ColumnRow Column(Row row) => new(row.Name("column_name"), TypeOf(row), row.Bool("is_identity"), row.Bool("is_computed"), row.Bool("is_sparse"),
        row.Bool("is_column_set"), row.Int("generated_code"), row.Bool("hidden_flag"), row.Long("graph_code") is { } graph ? (int)graph : null, row.Bool("dropped_flag"),
        row.Int("system_type_id"));

    public static ParameterRow Parameter(Row row) => new(row.Int("parameter_id"), row.Name("parameter_name"), TypeOf(row), row.Bool("is_output"), row.Bool("is_readonly"));

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
        /// <summary>An identifier exactly as stored ('' when absent).</summary>
        public string Name(string name) => values.TryGetValue(name, out var value) && value is string text ? text : "";
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

    /// <param name="waited">The statement took the whole lock timeout: a metadata function that answered 0 then was
    /// blocked by another session's schema lock, not refused.</param>
    private static PreflightResult Decide(ScriptingCatalog catalog, ObjectRefDto target, ScriptVerbRow verb, ScriptSubject subject, string database, Row? row,
        RowsetKind rowset = RowsetKind.None, IReadOnlyList<Row>? rows = null, bool waited = false)
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
        // A rowset that reached its TOP read one row past its limit.
        if (rowset != RowsetKind.None && rows!.Count >= Take(rowset, catalog)) return new(null, ScriptingErrors.Create(catalog, "TOO_LARGE", subject), []);
        var resolved = new ResolvedTarget(target, database, kind, subtype, catalogRow, subject, target.Parent?.Kind switch { "table" => "Table", "view" => "View", _ => null },
            row.Text("column_name"), sqlModule, encrypted, visible, bytes, row.Has("can_view_definition") ? row.Bool("can_view_definition") : null, row.Text("object_type"),
            rowset == RowsetKind.Columns ? [.. rows!.Select(Column)] : null, rowset == RowsetKind.Parameters ? [.. rows!.Select(Parameter)] : null,
            row.Has("credential_identity") ? row.Name("credential_identity") : null, row.Has("provider_name") ? row.Text("provider_name") : null);
        // SMO reads a module's definition for every verb that writes its body.
        if (sqlModule && verb.Verb is ScriptVerb.Create or ScriptVerb.Alter or ScriptVerb.CreateOrAlter or ScriptVerb.DropAndCreate)
        {
            if (encrypted == true) return new(null, ScriptingErrors.Create(catalog, "ENCRYPTED", subject), []);
            if (!visible) return new(null, ScriptingErrors.Create(catalog, "NO_DEFINITION", subject, kind == "serverTrigger" ? "server" : null), []);
            if (bytes > MaxDefinitionBytes) return new(null, ScriptingErrors.Create(catalog, "TOO_LARGE", subject, "definition"), []);
        }
        var warnings = new List<string>();
        if (kind == "table" && verb.Class == VerbClass.Ddl && resolved.CanViewDefinition == false)
        {
            if (waited) return new(null, ScriptingErrors.Create(catalog, "BLOCKED", subject), []);
            warnings.Add("You do not have VIEW DEFINITION permission on " + subject.Display + "; parts you cannot see (for example indexes or constraints) may be missing from the script.");
        }
        return new(resolved, null, warnings);
    }

    private static void Add(SqlCommand command, string name, SqlDbType type, int size, object? value)
    {
        var parameter = size == 0 ? new SqlParameter(name, type) : new SqlParameter(name, type, size);
        parameter.Value = value ?? DBNull.Value;
        command.Parameters.Add(parameter);
    }
}
