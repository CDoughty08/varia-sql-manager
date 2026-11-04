using Varia.Backend.Explorer;

namespace Varia.Backend.Search;

/// <summary>
/// The object index's constant SQL: one listing of the databases to index, read on the server's connection, and one batch per
/// database, run in it through <c>QUOTENAME(@db).sys.sp_executesql</c> (or directly on a connection already in it, on Azure SQL
/// Database). Catalog views only, joined for names; no metadata built-ins (they ignore the isolation level and lock timeout),
/// no values in the text. SQL Server's metadata visibility leaves out what the login may not see, and sys.sql_modules shows a
/// NULL definition where it may not VIEW DEFINITION, so the index holds only what Object Explorer and Script As could show.
/// </summary>
internal static class ObjectSearchSql
{
    /// <summary>Browsing's own prologue: READ UNCOMMITTED, LOCK_TIMEOUT 5000, DEADLOCK_PRIORITY LOW.</summary>
    public const string Prologue = CatalogSql.Prologue;

    /// <summary>Online databases the login may open, but tempdb and snapshots (which repeat their source), by name.</summary>
    public const string Databases = "SELECT d.name FROM sys.databases AS d WHERE d.state = 0 AND d.database_id <> 2 AND d.source_database_id IS NULL"
        + " AND HAS_DBACCESS(d.name) = 1 ORDER BY d.name;";

    /// <summary>Runs @stmt in @db, whose name reaches T-SQL only through QUOTENAME.</summary>
    public const string ModuleCall = "DECLARE @module nvarchar(300) = QUOTENAME(@db) + N'.sys.sp_executesql';\nEXEC @module @stmt;";

    /// <summary>The sys.objects types the index lists, as Object Explorer's folders do: tables (and external tables), views,
    /// procedures, functions, synonyms, sequences and DML triggers.</summary>
    internal const string ObjectTypes = "'U', 'ET', 'V', 'P', 'PC', 'X', 'FN', 'FS', 'IF', 'TF', 'FT', 'AF', 'SN', 'SO', 'TR'";

    /// <summary>
    /// One database's batch, in its order: the objects (with a DML trigger's parent), the user-defined types, the database DDL
    /// triggers, and, with <paramref name="definitions"/>, the module definitions by object id. Database diagrams' support
    /// objects are left out, as Object Explorer leaves them out. The definitions come last and in id order, so a reader with
    /// sequential access reads each one only as far as the index keeps it.
    /// </summary>
    public static string Batch(bool definitions) =>
        "SELECT o.object_id, s.name, o.name, o.type, o.modify_date, p.name, ps.name, p.type FROM sys.objects AS o JOIN sys.schemas AS s ON s.schema_id = o.schema_id"
        + " LEFT JOIN sys.objects AS p ON o.type = 'TR' AND p.object_id = o.parent_object_id LEFT JOIN sys.schemas AS ps ON ps.schema_id = p.schema_id"
        + " LEFT JOIN sys.extended_properties AS ep ON ep.class = 1 AND ep.major_id = o.object_id AND ep.minor_id = 0 AND ep.name = N'microsoft_database_tools_support'"
        + " WHERE o.is_ms_shipped = 0 AND ep.major_id IS NULL AND o.type IN (" + ObjectTypes + ") ORDER BY o.object_id;\n"
        + "SELECT t.user_type_id, s.name, t.name, t.is_table_type, t.is_assembly_type FROM sys.types AS t JOIN sys.schemas AS s ON s.schema_id = t.schema_id"
        + " WHERE t.is_user_defined = 1 ORDER BY t.user_type_id;\n"
        + "SELECT tr.object_id, tr.name, tr.modify_date FROM sys.triggers AS tr WHERE tr.parent_class = 0 AND tr.is_ms_shipped = 0 ORDER BY tr.object_id;\n"
        + (definitions ? "SELECT m.object_id, m.definition FROM sys.sql_modules AS m WHERE m.definition IS NOT NULL ORDER BY m.object_id;\n" : "");

    /// <summary>Problems with every statement the index runs; empty when they pass. Each passes Object Explorer's own lint
    /// (<see cref="CatalogSql.Lint"/>): the database listing may call HAS_DBACCESS, the batches may not.</summary>
    public static List<string> Lint()
    {
        var problems = new List<string>();
        foreach (var band in new[] { 12, 13, 14, 15, 16 })
        {
            var render = new SqlRender(band);
            problems.AddRange(CatalogSql.Lint(Databases, render, list: false, mayCheckAccess: true).Select(problem => "databases " + problem));
            foreach (var definitions in new[] { false, true })
                problems.AddRange(CatalogSql.Lint(Batch(definitions), render, list: false, mayCheckAccess: false).Select(problem => "batch " + problem));
        }
        foreach (var text in new[] { Databases, Batch(true), ModuleCall })
        {
            if (text.Contains("OBJECT_DEFINITION", StringComparison.OrdinalIgnoreCase)) problems.Add("reads OBJECT_DEFINITION");
            foreach (var write in new[] { "INSERT ", "UPDATE ", "DELETE ", "MERGE ", "CREATE ", "ALTER ", "DROP ", "EXEC (", "EXECUTE (", "#" })
                if (text.Contains(write, StringComparison.OrdinalIgnoreCase)) problems.Add("contains " + write.Trim());
        }
        if (Batch(true).Contains("@db", StringComparison.Ordinal)) problems.Add("the batch names @db");
        return problems;
    }
}
