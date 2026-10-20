using System.Globalization;
using System.Text;
using System.Text.Json;
using Varia.Backend.Actions;
using Varia.Backend.Explorer;
using Varia.Backend.Scripting;

namespace Varia.Backend.Designer;

/// <summary>The steps Save runs, in order, in one transaction.</summary>
internal enum DesignerPart { CreateTable, PrimaryKey, LockEscalation }

/// <summary>All SQL of the table designer (spec PR-G §4, decisions.md's design round): the describe and preflight as
/// constant catalog statements, SSMS's change script, and the builder batches Save runs. Save never sends statement text:
/// C# turns the validated plan into one JSON document (@design), and a constant builder batch per step has SQL Server shred
/// it with OPENJSON and compose the statement from QUOTENAME'd names, CONVERT of typed numbers and type keywords from a
/// constant VALUES table generated from the catalogue, then run it in the database through QUOTENAME(@db)'s sp_executesql.
/// <see cref="Statements"/> is what the builders compose, which the live dry run proves for hostile names; the script is
/// SSMS's text with its minimal quoting, which the live checks prove creates the same table.</summary>
internal static class DesignerSql
{
    private static string NL => ScriptFormatter.NewLine;
    private static string Quote(string name) => ScriptFormatter.Quote(name);

    /// <summary>SSMS's minimal quoting in a change script (catalog.ts' scriptName): a regular identifier that is not a
    /// reserved keyword or GO stays bare.</summary>
    public static string ScriptName(DesignerCatalog catalog, string name)
    {
        var regular = name.Length > 0 && (char.IsAsciiLetter(name[0]) || name[0] == '_') && name.All(c => char.IsAsciiLetterOrDigit(c) || c is '_' or '@' or '#' or '$');
        return regular && !catalog.ReservedKeywords.Contains(name) ? name : Quote(name);
    }

    /// <summary>The type as the grid and the script write it: nvarchar(MAX), decimal(18, 0), datetime2(7), int.</summary>
    public static string TypeText(PlanColumn column) => column.Type.Params switch
    {
        "length" or "nlength" => column.Type.Name + "(" + (column.Max ? "MAX" : Number(column.Length)) + ")",
        "precisionScale" => column.Type.Name + "(" + Number(column.Precision) + ", " + Number(column.Scale) + ")",
        "scale" => column.Type.Name + "(" + Number(column.Scale) + ")",
        "dimensions" => column.Type.Name + "(" + Number(column.Dimensions) + ")",
        _ => column.Type.Name
    };
    private static string Number(int? value) => value!.Value.ToString(CultureInfo.InvariantCulture);
    private static string Definition(PlanColumn column, string name) => name + " " + TypeText(column) + (column.AllowNulls ? " NULL" : " NOT NULL")
        + (column.Identity ? " IDENTITY (" + column.Seed + ", " + column.Increment + ")" : "");
    private const string KeyOptions = "STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON";

    /// <summary>The statements Save runs, names always bracketed: what the builder batches compose from @design.</summary>
    public static List<(DesignerPart Part, string Text)> Statements(TablePlan plan, string filegroup)
    {
        var table = Quote(plan.Schema) + "." + Quote(plan.Name);
        var list = new List<(DesignerPart, string)>
        {
            (DesignerPart.CreateTable, "CREATE TABLE " + table + " (" + string.Join(", ", plan.Columns.Select(column => Definition(column, Quote(column.Name)))) + ") ON " + Quote(filegroup)
                + (plan.Columns.Any(column => column.Lob) ? " TEXTIMAGE_ON " + Quote(filegroup) : ""))
        };
        if (plan.PrimaryKey.Count > 0)
            list.Add((DesignerPart.PrimaryKey, "ALTER TABLE " + table + " ADD CONSTRAINT " + Quote(plan.PrimaryKeyName) + " PRIMARY KEY CLUSTERED ("
                + string.Join(", ", plan.PrimaryKey.Select(index => Quote(plan.Columns[index].Name))) + ") WITH (" + KeyOptions + ") ON " + Quote(filegroup)));
        list.Add((DesignerPart.LockEscalation, "ALTER TABLE " + table + " SET (LOCK_ESCALATION = TABLE)"));
        return list;
    }

    /// <summary>SSMS's Save Change Script text (spec PR-G §1.8). The prologue, the key block, ON [PRIMARY] and LOCK_ESCALATION
    /// are verified against SSMS change scripts; the IDENTITY and TEXTIMAGE_ON shapes and the block order are not.</summary>
    public static string Script(DesignerCatalog catalog, TablePlan plan, string filegroup)
    {
        var table = ScriptName(catalog, plan.Schema) + "." + ScriptName(catalog, plan.Name);
        var text = new StringBuilder();
        void Line(string value) => text.Append(value).Append(NL);
        Line("/* To prevent any potential data loss issues, you should review this script in detail before running it outside the context of the database designer.*/");
        foreach (var value in new[] { "BEGIN TRANSACTION", "SET QUOTED_IDENTIFIER ON", "SET ARITHABORT ON", "SET NUMERIC_ROUNDABORT OFF", "SET CONCAT_NULL_YIELDS_NULL ON", "SET ANSI_NULLS ON",
            "SET ANSI_PADDING ON", "SET ANSI_WARNINGS ON", "COMMIT", "BEGIN TRANSACTION", "GO" }) Line(value);
        Line("CREATE TABLE " + table);
        Line("\t(");
        for (var index = 0; index < plan.Columns.Count; index++)
            Line("\t" + Definition(plan.Columns[index], ScriptName(catalog, plan.Columns[index].Name)) + (index < plan.Columns.Count - 1 ? "," : ""));
        Line("\t)  ON " + Quote(filegroup));
        if (plan.Columns.Any(column => column.Lob)) Line("\t TEXTIMAGE_ON " + Quote(filegroup));
        Line("GO");
        if (plan.PrimaryKey.Count > 0)
        {
            Line("ALTER TABLE " + table + " ADD CONSTRAINT");
            Line("\t" + ScriptName(catalog, plan.PrimaryKeyName) + " PRIMARY KEY CLUSTERED ");
            Line("\t(");
            for (var index = 0; index < plan.PrimaryKey.Count; index++)
                Line("\t" + ScriptName(catalog, plan.Columns[plan.PrimaryKey[index]].Name) + (index < plan.PrimaryKey.Count - 1 ? "," : ""));
            Line("\t) WITH( " + KeyOptions + ") ON " + Quote(filegroup));
            Line("");
            Line("GO");
        }
        Line("ALTER TABLE " + table + " SET (LOCK_ESCALATION = TABLE)");
        Line("GO");
        Line("COMMIT");
        return text.ToString();
    }

    /// <summary>The builders' one parameter: the plan as JSON, types by catalogue id, numbers typed, seeds as text.</summary>
    public static string DesignJson(DesignerCatalog catalog, TablePlan plan, string filegroup)
    {
        using var buffer = new MemoryStream();
        using (var json = new Utf8JsonWriter(buffer))
        {
            json.WriteStartObject();
            json.WriteString("schema", plan.Schema);
            json.WriteString("name", plan.Name);
            json.WriteString("pk", plan.PrimaryKeyName);
            json.WriteString("filegroup", filegroup);
            json.WriteStartArray("columns");
            foreach (var column in plan.Columns)
            {
                json.WriteStartObject();
                json.WriteString("name", column.Name);
                json.WriteNumber("type", catalog.IdOf(column.Type.Name));
                void Int(string key, int? value) { if (value is { } number) json.WriteNumber(key, number); else json.WriteNull(key); }
                Int("length", column.Length);
                json.WriteBoolean("max", column.Max);
                Int("precision", column.Precision);
                Int("scale", column.Scale);
                Int("dimensions", column.Dimensions);
                json.WriteBoolean("nullable", column.AllowNulls);
                json.WriteBoolean("identity", column.Identity);
                if (column.Identity) { json.WriteString("seed", column.Seed); json.WriteString("increment", column.Increment); }
                json.WriteEndObject();
            }
            json.WriteEndArray();
            json.WriteStartArray("key");
            foreach (var index in plan.PrimaryKey) json.WriteNumberValue(index);
            json.WriteEndArray();
            json.WriteEndObject();
        }
        return Encoding.UTF8.GetString(buffer.ToArray());
    }

    // --- Builder batches -----------------------------------------------------------------------------------------------

    /// <summary>The fixed messages and module suffix the builders hold besides keyword text (ActionSql.LintExecutable).</summary>
    public static readonly IReadOnlySet<string> Messages = new HashSet<string>(StringComparer.Ordinal)
        { "N'A name could not be quoted.'", "N'The design could not be read.'", "N'A column could not be built.'", "N'.'", "N'.sys.sp_executesql'" };

    /// <summary>Shreds @design: the table, key and filegroup names only through QUOTENAME, the columns and key as JSON.</summary>
    private const string Shred = "IF ISNULL(ISJSON(@design), 0) = 0 THROW 50000, N'The design could not be read.', 1;\n"
        + "DECLARE @table nvarchar(max), @pk nvarchar(max), @filegroup nvarchar(max), @columns nvarchar(max), @key nvarchar(max);\n"
        + "SELECT @table = QUOTENAME(d.[schema]) + N'.' + QUOTENAME(d.[name]), @pk = QUOTENAME(d.pk), @filegroup = QUOTENAME(d.filegroup), @columns = d.columns, @key = d.[key] "
        + "FROM OPENJSON(@design) WITH ([schema] nvarchar(max), [name] nvarchar(max), pk nvarchar(max), filegroup nvarchar(max), columns nvarchar(max) AS JSON, [key] nvarchar(max) AS JSON) AS d;\n"
        + "IF @table IS NULL OR @pk IS NULL OR @filegroup IS NULL OR @columns IS NULL OR @key IS NULL THROW 50000, N'A name could not be quoted.', 1;\n";

    /// <summary>The catalogue's types as a constant VALUES table: id, keyword, parameter form (0 none, 1 a length or MAX, 2
    /// precision and scale, 3 a scale, 4 dimensions) and whether it is stored off-row.</summary>
    public static string TypeTable(DesignerCatalog catalog) => "(VALUES " + string.Join(", ", catalog.Types.Select((type, id) => "(" + id.ToString(CultureInfo.InvariantCulture) + ", N'" + type.Name + "', "
        + Form(type.Params).ToString(CultureInfo.InvariantCulture) + ", " + (type.Lob == true ? "1" : "0") + ")")) + ") AS t(id, keyword, form, lob)";
    private static int Form(string kind) => kind switch { "none" => 0, "length" or "nlength" => 1, "precisionScale" => 2, "scale" => 3, "dimensions" => 4, _ => throw new InvalidOperationException("Unknown parameter kind " + kind) };

    private static string Columns(DesignerCatalog catalog) => "DECLARE @c TABLE (ordinal int PRIMARY KEY, definition nvarchar(max) NULL, lob bit NULL);\n"
        + "INSERT @c (ordinal, definition, lob) SELECT CONVERT(int, a.[key]), QUOTENAME(j.[name]) + N' ' + t.keyword + CASE t.form WHEN 0 THEN N'' "
        + "WHEN 1 THEN CASE j.[max] WHEN 1 THEN N'(MAX)' ELSE N'(' + CONVERT(nvarchar(10), j.length) + N')' END "
        + "WHEN 2 THEN N'(' + CONVERT(nvarchar(10), j.[precision]) + N', ' + CONVERT(nvarchar(10), j.scale) + N')' WHEN 3 THEN N'(' + CONVERT(nvarchar(10), j.scale) + N')' "
        + "WHEN 4 THEN N'(' + CONVERT(nvarchar(10), j.dimensions) + N')' END + CASE j.nullable WHEN 1 THEN N' NULL' WHEN 0 THEN N' NOT NULL' END "
        + "+ CASE j.[identity] WHEN 1 THEN N' IDENTITY (' + CONVERT(nvarchar(40), j.seed) + N', ' + CONVERT(nvarchar(40), j.increment) + N')' WHEN 0 THEN N'' END, "
        + "CASE WHEN t.lob = 1 OR j.[max] = 1 THEN 1 ELSE 0 END "
        + "FROM OPENJSON(@columns) AS a CROSS APPLY OPENJSON(a.value) WITH ([name] nvarchar(max), [type] int, length int, [max] bit, [precision] int, scale int, dimensions int, nullable bit, "
        + "[identity] bit, seed decimal(38, 0), increment decimal(38, 0)) AS j LEFT JOIN " + TypeTable(catalog) + " ON t.id = j.[type];\n"
        + "IF NOT EXISTS (SELECT 1 FROM @c) OR EXISTS (SELECT 1 FROM @c AS c WHERE c.definition IS NULL) THROW 50000, N'A column could not be built.', 1;\n";

    private const string Keys = "DECLARE @k TABLE (position int PRIMARY KEY, quoted nvarchar(max) NULL);\n"
        + "INSERT @k (position, quoted) SELECT CONVERT(int, k.[key]), n.quoted FROM OPENJSON(@key) AS k LEFT JOIN "
        + "(SELECT CONVERT(int, a.[key]) AS ordinal, QUOTENAME(j.[name]) AS quoted FROM OPENJSON(@columns) AS a CROSS APPLY OPENJSON(a.value) WITH ([name] nvarchar(max)) AS j) AS n "
        + "ON n.ordinal = CONVERT(int, k.value);\n"
        + "IF NOT EXISTS (SELECT 1 FROM @k) OR EXISTS (SELECT 1 FROM @k AS q WHERE q.quoted IS NULL) THROW 50000, N'A column could not be built.', 1;\n";

    /// <summary>Concatenates a table variable's text column in order, comma separated, without FOR XML (which refuses the
    /// control characters a name may hold) or STRING_AGG (SQL Server 2017).</summary>
    private static string Join(string table, string order, string column, string into) =>
        "DECLARE @i int = 0, @n int = (SELECT COUNT(*) FROM " + table + "), " + into + " nvarchar(max) = N'';\n"
        + "WHILE @i < @n BEGIN SELECT " + into + " = " + into + " + CASE WHEN @i = 0 THEN N'' ELSE N', ' END + x." + column + " FROM " + table + " AS x WHERE x." + order + " = @i; SET @i = @i + 1; END;\n";

    /// <summary>The batch that runs a step: SQL Server builds the statement from @design and runs it in @db.
    /// <paramref name="dryRun"/> (the live checks only, never the wire) selects it instead.</summary>
    public static string Builder(DesignerCatalog catalog, DesignerPart part, bool dryRun = false)
    {
        var text = new StringBuilder(Shred);
        switch (part)
        {
            case DesignerPart.CreateTable:
                text.Append(Columns(catalog)).Append(Join("@c", "ordinal", "definition", "@body"))
                    .Append("DECLARE @stmt nvarchar(max) = N'CREATE TABLE ' + @table + N' (' + @body + N') ON ' + @filegroup + CASE WHEN EXISTS (SELECT 1 FROM @c AS c WHERE c.lob = 1) THEN N' TEXTIMAGE_ON ' + @filegroup ELSE N'' END;\n");
                break;
            case DesignerPart.PrimaryKey:
                text.Append(Keys).Append(Join("@k", "position", "quoted", "@list"))
                    .Append("DECLARE @stmt nvarchar(max) = N'ALTER TABLE ' + @table + N' ADD CONSTRAINT ' + @pk + N' PRIMARY KEY CLUSTERED (' + @list + N') WITH (" + KeyOptions + ") ON ' + @filegroup;\n");
                break;
            case DesignerPart.LockEscalation:
                text.Append("DECLARE @stmt nvarchar(max) = N'ALTER TABLE ' + @table + N' SET (LOCK_ESCALATION = TABLE)';\n");
                break;
        }
        text.Append(ActionSql.Guard).Append(dryRun ? "SELECT @stmt AS stmt;" : "DECLARE @module nvarchar(300) = QUOTENAME(@db) + N'.sys.sp_executesql';\nEXEC @module @stmt;");
        return text.ToString();
    }

    // --- Catalog statements ------------------------------------------------------------------------------------------

    /// <summary>In master: the database's state, the login's access and advisory CREATE TABLE permission, whether it is
    /// read-only, and master's compatibility level (the builders' OPENJSON needs 130).</summary>
    public const string MasterFacts = "SELECT d.state AS state, d.state_desc AS state_desc, d.is_read_only AS is_read_only, "
        + "CONVERT(bit, ISNULL(CASE WHEN d.user_access = 1 THEN 1 ELSE HAS_DBACCESS(d.name) END, 0)) AS has_access, "
        + "CONVERT(bit, HAS_PERMS_BY_NAME(d.name, N'DATABASE', N'CREATE TABLE')) AS can_create, "
        + "(SELECT m.compatibility_level FROM sys.databases AS m WHERE m.database_id = 1) AS master_level "
        + "FROM sys.databases AS d WHERE d.name = @db;";

    /// <summary>In the database (ModuleCall): at most @take schemas but sys and INFORMATION_SCHEMA, by name, then the default
    /// rows filegroup.</summary>
    public const string Describe = "SELECT TOP (@take) s.name AS schema_name FROM sys.schemas AS s WHERE s.schema_id NOT IN (3, 4) ORDER BY s.name;\n"
        + "SELECT fg.name AS filegroup_name FROM sys.filegroups AS fg WHERE fg.is_default = 1 AND fg.type = 'FG';";

    /// <summary>In the database (ModuleCall, @schema, @name the table and @new the key's name): whether the schema exists,
    /// advisory ALTER on it, whether the table's or the key's name is taken in it, and the default rows filegroup. A check
    /// that cannot answer (NULL) does not refuse: HAS_PERMS_BY_NAME parses its securable, so it takes the schema bracketed,
    /// and only when the bracketed name fits its sysname (it answers 0, not NULL, for a name it misreads).</summary>
    public const string Preflight = "SELECT CONVERT(bit, CASE WHEN EXISTS (SELECT 1 FROM sys.schemas AS s WHERE s.name = @schema) THEN 1 ELSE 0 END) AS schema_exists, "
        + "CONVERT(bit, ISNULL(CASE WHEN DATALENGTH(QUOTENAME(@schema)) <= 256 THEN HAS_PERMS_BY_NAME(QUOTENAME(@schema), N'SCHEMA', N'ALTER') END, 1)) AS can_alter, "
        + "CONVERT(bit, CASE WHEN EXISTS (SELECT 1 FROM sys.objects AS o JOIN sys.schemas AS s ON s.schema_id = o.schema_id WHERE s.name = @schema AND o.name = @name) THEN 1 ELSE 0 END) AS name_in_use, "
        + "CONVERT(bit, CASE WHEN EXISTS (SELECT 1 FROM sys.objects AS o JOIN sys.schemas AS s ON s.schema_id = o.schema_id WHERE s.name = @schema AND o.name = @new) THEN 1 ELSE 0 END) AS key_in_use, "
        + "(SELECT fg.name FROM sys.filegroups AS fg WHERE fg.is_default = 1 AND fg.type = 'FG') AS filegroup_name;";

    // --- Lint ------------------------------------------------------------------------------------------------------------

    /// <summary>Every builder (run and dry run) with ActionSql.LintExecutable's designer form, and every catalog statement
    /// for every band with its catalog form (DesignerChecks).</summary>
    public static IEnumerable<(string Name, List<string> Problems)> Lint(DesignerCatalog catalog)
    {
        foreach (var part in Enum.GetValues<DesignerPart>())
            foreach (var dry in new[] { false, true })
                yield return ("designer " + part + (dry ? " (dry run)" : ""), ActionSql.LintExecutable(Builder(catalog, part, dry), new DesignBuilderRules(Messages, catalog.Types.Select(type => type.Name).ToHashSet(StringComparer.Ordinal))));
        for (var band = ExplorerCatalog.MinBand; band <= ExplorerCatalog.MaxBand; band++)
        {
            yield return ("designer describe band " + band, ActionSql.LintCatalog(Describe, band, database: true));
            yield return ("designer preflight band " + band, ActionSql.LintCatalog(Preflight, band, database: true));
        }
        yield return ("designer master facts", ActionSql.LintCatalog(MasterFacts, ExplorerCatalog.MaxBand, database: false));
    }
}
