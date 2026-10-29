using System.Globalization;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace Varia.Backend.Tests;

internal sealed record ShapeColumn(string Name, string Type, int MaxLength, int Precision, int Scale, bool Nullable);
/// <summary>A procedure's or function's parameter. Default is the declared default as written (NULL in capitals), read from the
/// module's text because sys.parameters does not hold T-SQL defaults; null when there is none.</summary>
internal sealed record ShapeParameter(string Name, string Type, int MaxLength, bool Output, string? Default = null);
internal sealed record ShapeIndex(string Table, string Name, string Type, bool PrimaryKey, bool Unique, List<string> Keys);
internal sealed record ShapeForeignKey(string Name, string Child, string Parent, string OnDelete, List<string> Columns);
internal sealed record ShapeDatabase(int CompatibilityLevel, bool ReadCommittedSnapshot, string Collation);

/// <summary>One SSIS catalog's shape at one server band: what the real catalog's views, procedures and functions look like,
/// the internal identities, indexes and foreign keys the tails rely on, the procedures that refuse SQL Server authentication
/// (error 27123), SSISDB's SSIS-to-SQL type map and the catalog's error texts. Source, product version, schema build,
/// database settings and catalog properties describe where it was read and are never compared: an owner may change them.</summary>
internal sealed record CatalogShape(int Band, string Source, string ProductVersion, string SchemaVersion, string SchemaBuild, ShapeDatabase Database,
    Dictionary<string, string> Properties, Dictionary<string, List<ShapeColumn>> Views, Dictionary<string, List<ShapeParameter>> Procedures,
    Dictionary<string, List<ShapeParameter>> Functions, List<string> Identities, List<ShapeIndex> Indexes, List<ShapeForeignKey> ForeignKeys,
    List<string> SqlAuthRefused, Dictionary<string, List<string>> TypeMapping, Dictionary<string, string> Errors);

internal sealed record ManifestFile(string Comment, List<CatalogShape> Catalogs);

/// <summary>tests/fixtures/ssisdb/manifest.json (D-ssis 12.2, 12.3): read from a real SSISDB, or from the Integration Services
/// feature's catalog backup restored under a scratch name, and checked in. The fake catalog is generated from it, and the drift
/// check fails when a real catalog differs from it.</summary>
internal static partial class SsisManifest
{
    public const string Comment = "Shape of the SSIS catalog (SSISDB) per SQL Server band. Written by backend/Varia.Backend.Tests with VARIA_TEST_SQL_SCRATCH=1, "
        + "VARIA_TEST_SSIS=1 and VARIA_UPDATE_SSIS_MANIFEST=1; tests/fixtures/ssisdb/schema.sql is generated from it (npx vitest run tests/ssisdb-fixtures.test.ts -u). Do not edit by hand.";

    /// <summary>The catalog errors the fake raises and D-ssis maps to values, with their texts from sys.messages.</summary>
    public static readonly int[] ErrorNumbers = [27100, 27101, 27103, 27104, 27109, 27121, 27123, 27124, 27125, 27126, 27138, 27143, 27146, 27147, 27176, 27178, 27188, 27195, 27224];

    private static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web) { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping, DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull };

    public static string Folder() => Path.Combine(GoldenText.Repository(), "tests", "fixtures", "ssisdb");
    public static string PathOf() => Path.Combine(Folder(), "manifest.json");

    public static ManifestFile Parse(string text) => JsonSerializer.Deserialize<ManifestFile>(text, Web) ?? throw new InvalidDataException("manifest.json is empty.");
    public static ManifestFile Load() => Parse(File.ReadAllText(PathOf()));

    /// <summary>The manifest with this band's entry replaced (or added), bands in order.</summary>
    public static ManifestFile With(ManifestFile? file, CatalogShape shape) =>
        new(Comment, [.. (file?.Catalogs ?? []).Where(entry => entry.Band != shape.Band).Append(shape).OrderBy(entry => entry.Band)]);

    private static string Json<T>(T value) => JsonSerializer.Serialize(value, Web);

    /// <summary>The canonical text: two-space indents, one line per column, parameter, index, key, list and error, LF endings.</summary>
    public static string Write(ManifestFile file)
    {
        var text = new StringBuilder();
        text.Append("{\n  \"comment\": ").Append(Json(file.Comment)).Append(",\n  \"catalogs\": [");
        for (var index = 0; index < file.Catalogs.Count; index++)
        {
            var shape = file.Catalogs[index];
            text.Append(index == 0 ? "\n" : ",\n").Append("    {\n");
            text.Append("      \"band\": ").Append(shape.Band.ToString(CultureInfo.InvariantCulture)).Append(",\n");
            foreach (var (key, value) in new[] { ("source", shape.Source), ("productVersion", shape.ProductVersion), ("schemaVersion", shape.SchemaVersion), ("schemaBuild", shape.SchemaBuild) })
                text.Append("      \"").Append(key).Append("\": ").Append(Json(value)).Append(",\n");
            text.Append("      \"database\": ").Append(Json(shape.Database)).Append(",\n");
            Map(text, "properties", shape.Properties, Json);
            Map(text, "views", shape.Views, columns => Lines(columns.Select(Json)));
            Map(text, "procedures", shape.Procedures, parameters => Lines(parameters.Select(Json)));
            Map(text, "functions", shape.Functions, parameters => Lines(parameters.Select(Json)));
            text.Append("      \"identities\": ").Append(Lines(shape.Identities.Select(Json), 6)).Append(",\n");
            text.Append("      \"indexes\": ").Append(Lines(shape.Indexes.Select(Json), 6)).Append(",\n");
            text.Append("      \"foreignKeys\": ").Append(Lines(shape.ForeignKeys.Select(Json), 6)).Append(",\n");
            text.Append("      \"sqlAuthRefused\": ").Append(Lines(shape.SqlAuthRefused.Select(Json), 6)).Append(",\n");
            Map(text, "typeMapping", shape.TypeMapping, Json);
            Map(text, "errors", shape.Errors, Json, last: true);
            text.Append("    }");
        }
        text.Append("\n  ]\n}\n");
        return text.ToString();
    }

    private static string Lines(IEnumerable<string> items, int indent = 8)
    {
        var list = items.ToList();
        if (list.Count == 0) return "[]";
        var pad = new string(' ', indent);
        return "[\n" + string.Join(",\n", list.Select(item => pad + "  " + item)) + "\n" + pad + "]";
    }

    private static void Map<T>(StringBuilder text, string name, Dictionary<string, T> map, Func<T, string> value, bool last = false)
    {
        text.Append("      \"").Append(name).Append("\": {");
        var keys = map.Keys.OrderBy(key => key, StringComparer.Ordinal).ToList();
        for (var index = 0; index < keys.Count; index++)
            text.Append(index == 0 ? "\n" : ",\n").Append("        ").Append(Json(keys[index])).Append(": ").Append(value(map[keys[index]]));
        text.Append(keys.Count == 0 ? "}" : "\n      }").Append(last ? "\n" : ",\n");
    }

    // A parameter declaration: the name, a type (optionally schema-qualified, with a length), and an optional default. The
    // first match per name is its declaration, because a module declares its parameters before its body uses them.
    [GeneratedRegex(@"@(?<name>\w+)\s+(?:AS\s+)?(?:\[?\w+\]?\s*\.\s*)?\[?\w+\]?(?:\s*\([^)]*\))?(?:\s+VARYING)?\s*(?:=\s*(?<value>N?'(?:[^']|'')*'|[-+]?\d+(?:\.\d+)?|\w+))?", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex Declaration();

    /// <summary>The default each parameter of a module declares, by parameter name (with its @), from the module's text; a
    /// parameter without a default is absent. NULL is written in capitals so either spelling compares equal.</summary>
    public static Dictionary<string, string> Defaults(string definition)
    {
        var defaults = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (Match match in Declaration().Matches(WithoutComments(definition)))
        {
            var name = "@" + match.Groups["name"].Value;
            if (!seen.Add(name) || !match.Groups["value"].Success) continue;
            var value = match.Groups["value"].Value;
            defaults[name] = value.Equals("NULL", StringComparison.OrdinalIgnoreCase) ? "NULL" : value;
        }
        return defaults;
    }

    /// <summary>T-SQL text with its line and (nested) block comments blanked out, leaving quoted strings and brackets alone.</summary>
    private static string WithoutComments(string text)
    {
        var output = new StringBuilder(text.Length);
        for (var index = 0; index < text.Length; index++)
        {
            var character = text[index];
            if (character is '\'' or '[')
            {
                var close = character == '\'' ? '\'' : ']';
                var end = index + 1;
                while (end < text.Length)
                {
                    if (text[end] != close) end++;
                    else if (end + 1 < text.Length && text[end + 1] == close) end += 2;
                    else break;
                }
                output.Append(text, index, Math.Min(text.Length, end + 1) - index);
                index = end;
            }
            else if (character == '-' && index + 1 < text.Length && text[index + 1] == '-')
            {
                while (index < text.Length && text[index] != '\n') index++;
                output.Append('\n');
            }
            else if (character == '/' && index + 1 < text.Length && text[index + 1] == '*')
            {
                var depth = 0;
                for (; index < text.Length; index++)
                {
                    if (text[index] == '/' && index + 1 < text.Length && text[index + 1] == '*') { depth++; index++; }
                    else if (text[index] == '*' && index + 1 < text.Length && text[index + 1] == '/' && --depth == 0) { index++; break; }
                }
                output.Append(' ');
            }
            else output.Append(character);
        }
        return output.ToString();
    }

    /// <summary>Where the Integration Services feature keeps its catalog backup, from the engine's service command line in
    /// sys.dm_server_services: the shared folder above MSSQL&lt;n&gt;.&lt;instance&gt;, then &lt;major&gt;0\DTS\Binn. SQL Server 2025
    /// names it SSISDBBackup.bak; earlier versions SSISDB.bak. Null when the line is not a Windows install's.</summary>
    public static string? BackupPath(string? serviceCommandLine, int major)
    {
        if (string.IsNullOrWhiteSpace(serviceCommandLine)) return null;
        var line = serviceCommandLine.Trim();
        var executable = line.StartsWith('"') ? line[1..Math.Max(1, line.IndexOf('"', 1))] : line.Split(' ')[0];
        var parts = executable.Split('\\');
        var instance = Array.FindLastIndex(parts, part => part.StartsWith("MSSQL", StringComparison.OrdinalIgnoreCase) && part.Contains('.'));
        if (instance < 1 || !executable.EndsWith("\\sqlservr.exe", StringComparison.OrdinalIgnoreCase)) return null;
        var root = string.Join("\\", parts[..instance]);
        return root + "\\" + (major * 10).ToString(CultureInfo.InvariantCulture) + "\\DTS\\Binn\\" + (major >= 17 ? "SSISDBBackup.bak" : "SSISDB.bak");
    }

    /// <summary>Every way <paramref name="actual"/> differs from <paramref name="expected"/>. For the fake catalog only the views
    /// (as tables) and the stub procedures it has are compared, plus whether each stub refuses SQL Server authentication as the
    /// real procedure does.</summary>
    public static List<string> Compare(CatalogShape expected, CatalogShape actual, bool fake = false)
    {
        var differences = new List<string>();
        void Lists<T>(string what, IReadOnlyList<T> want, IReadOnlyList<T> have, Func<T, string> name, bool missingOnly = false)
        {
            if (want.Count != have.Count && !missingOnly) differences.Add(what + " has " + have.Count + " entries, the manifest " + want.Count);
            for (var index = 0; index < Math.Min(want.Count, have.Count); index++)
                if (!Equals(want[index], have[index]))
                {
                    differences.Add(what + " differs at " + name(want[index]) + ": " + Json(have[index]) + " instead of " + Json(want[index]));
                    return;
                }
        }
        void Objects<T>(string kind, Dictionary<string, List<T>> want, Dictionary<string, List<T>> have, Func<T, string> name, bool subset)
        {
            foreach (var key in want.Keys.Order(StringComparer.Ordinal))
                if (!have.TryGetValue(key, out var members)) { if (!subset) differences.Add(kind + " " + key + " is missing"); }
                else Lists(kind + " " + key, want[key], members, name);
            foreach (var key in have.Keys.Where(key => !want.ContainsKey(key)).Order(StringComparer.Ordinal)) differences.Add(kind + " " + key + " is not in the manifest");
        }
        void Sets(string what, IEnumerable<string> want, IEnumerable<string> have)
        {
            var wanted = want.ToHashSet(StringComparer.Ordinal);
            var had = have.ToHashSet(StringComparer.Ordinal);
            foreach (var item in wanted.Except(had).Order(StringComparer.Ordinal)) differences.Add(what + " lacks " + item);
            foreach (var item in had.Except(wanted).Order(StringComparer.Ordinal)) differences.Add(what + " has " + item + ", which the manifest does not");
        }
        Objects("view", expected.Views, actual.Views, column => column.Name, subset: false);
        Objects("procedure", expected.Procedures, actual.Procedures, parameter => parameter.Name, subset: fake);
        if (fake)
        {
            Sets("SQL authentication refusal", expected.SqlAuthRefused.Where(actual.Procedures.ContainsKey), actual.SqlAuthRefused);
            return differences;
        }
        if (expected.SchemaVersion != actual.SchemaVersion) differences.Add("schema version " + actual.SchemaVersion + " instead of " + expected.SchemaVersion);
        Objects("function", expected.Functions, actual.Functions, parameter => parameter.Name, subset: false);
        Sets("identities", expected.Identities, actual.Identities);
        Sets("indexes", expected.Indexes.Select(Json), actual.Indexes.Select(Json));
        Sets("foreign keys", expected.ForeignKeys.Select(Json), actual.ForeignKeys.Select(Json));
        Sets("SQL authentication refusal", expected.SqlAuthRefused, actual.SqlAuthRefused);
        Sets("type mapping", expected.TypeMapping.SelectMany(pair => pair.Value.Select(sql => pair.Key + " " + sql)), actual.TypeMapping.SelectMany(pair => pair.Value.Select(sql => pair.Key + " " + sql)));
        Sets("errors", expected.Errors.Select(pair => pair.Key + " " + pair.Value), actual.Errors.Select(pair => pair.Key + " " + pair.Value));
        return differences;
    }
}

/// <summary>Reads a catalog's shape from its own system catalog views (sys.objects, sys.columns, sys.parameters, sys.types
/// and so on): no metadata built-ins, so the same text reads the real SSISDB, the restored backup and the fake.</summary>
internal static class SsisShapeReader
{
    // Alias types (SSISDB's internal.adt_*) read as their base type, so the fake's plain types compare equal; table and CLR
    // types keep their own names.
    private const string TypeName = "COALESCE(b.name, t.name)";
    private const string TypeJoin = "LEFT JOIN sys.types AS t ON t.user_type_id = {0}.user_type_id LEFT JOIN sys.types AS b ON b.user_type_id = t.system_type_id AND t.is_user_defined = 1 AND t.is_table_type = 0 AND t.is_assembly_type = 0";

    public const string ViewsSql = "SELECT o.name, c.name, " + TypeName + ", c.max_length, c.precision, c.scale, c.is_nullable\n"
        + "FROM sys.objects AS o JOIN sys.schemas AS s ON s.schema_id = o.schema_id JOIN sys.columns AS c ON c.object_id = o.object_id\n"
        + "{0}\nWHERE s.name = N'catalog' AND o.type IN ('V', 'U') AND o.name NOT LIKE N'varia[_]%'\nORDER BY o.name, c.column_id;";

    public const string ModulesSql = "SELECT o.name, o.type, p.name, " + TypeName + ", p.max_length, p.is_output\n"
        + "FROM sys.objects AS o JOIN sys.schemas AS s ON s.schema_id = o.schema_id LEFT JOIN sys.parameters AS p ON p.object_id = o.object_id\n"
        + "{0}\nWHERE s.name = N'catalog' AND o.type IN ('P', 'FN', 'IF', 'TF') AND o.name NOT LIKE N'varia[_]%'\nORDER BY o.name, p.parameter_id;";

    // The start of each module's text, which holds its parameter declarations and their defaults (sys.parameters has no
    // T-SQL defaults); 8,000 characters reach past the catalog's longest parameter list.
    public const string HeadersSql = "SELECT o.name, LEFT(m.definition, 8000) FROM sys.objects AS o JOIN sys.schemas AS s ON s.schema_id = o.schema_id\n"
        + "JOIN sys.sql_modules AS m ON m.object_id = o.object_id\nWHERE s.name = N'catalog' AND o.type IN ('P', 'FN', 'IF', 'TF') AND o.name NOT LIKE N'varia[_]%';";

    public const string IdentitiesSql = "SELECT s.name + N'.' + o.name + N'.' + c.name FROM sys.identity_columns AS c JOIN sys.objects AS o ON o.object_id = c.object_id\n"
        + "JOIN sys.schemas AS s ON s.schema_id = o.schema_id WHERE s.name = N'internal' AND o.type = 'U' ORDER BY 1;";

    public const string IndexesSql = "SELECT s.name + N'.' + o.name, i.name, i.type_desc, i.is_primary_key, i.is_unique, c.name\n"
        + "FROM sys.indexes AS i JOIN sys.objects AS o ON o.object_id = i.object_id JOIN sys.schemas AS s ON s.schema_id = o.schema_id\n"
        + "JOIN sys.index_columns AS ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0\n"
        + "JOIN sys.columns AS c ON c.object_id = ic.object_id AND c.column_id = ic.column_id\n"
        + "WHERE s.name = N'internal' AND o.type = 'U' AND i.name IS NOT NULL ORDER BY 1, 2, ic.key_ordinal;";

    public const string ForeignKeysSql = "SELECT fk.name, cs.name + N'.' + co.name, ps.name + N'.' + po.name, fk.delete_referential_action_desc, pc.name + N' -> ' + rc.name\n"
        + "FROM sys.foreign_keys AS fk\n"
        + "JOIN sys.objects AS co ON co.object_id = fk.parent_object_id JOIN sys.schemas AS cs ON cs.schema_id = co.schema_id\n"
        + "JOIN sys.objects AS po ON po.object_id = fk.referenced_object_id JOIN sys.schemas AS ps ON ps.schema_id = po.schema_id\n"
        + "JOIN sys.foreign_key_columns AS fkc ON fkc.constraint_object_id = fk.object_id\n"
        + "JOIN sys.columns AS pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id\n"
        + "JOIN sys.columns AS rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id\n"
        + "WHERE ps.name = N'internal' ORDER BY fk.name, fkc.constraint_column_id;";

    /// <summary>The catalog procedures that raise 27123 ("cannot be started by an account that uses SQL Server
    /// Authentication") themselves or through a module they call.</summary>
    public const string SqlAuthSql = "WITH refusing AS (\n"
        + "    SELECT m.object_id, 0 AS depth FROM sys.sql_modules AS m WHERE REPLACE(m.definition, N' ', N'') LIKE N'%RAISERROR(27123,%'\n"
        + "    UNION ALL\n"
        + "    SELECT d.referencing_id, r.depth + 1 FROM sys.sql_expression_dependencies AS d JOIN refusing AS r ON r.object_id = d.referenced_id WHERE r.depth < 6\n"
        + ")\n"
        + "SELECT DISTINCT o.name FROM sys.objects AS o JOIN sys.schemas AS s ON s.schema_id = o.schema_id JOIN refusing AS r ON r.object_id = o.object_id\n"
        + "WHERE s.name = N'catalog' AND o.type = 'P' AND o.name NOT LIKE N'varia[_]%' ORDER BY o.name;";

    public const string TypeMappingSql = "SELECT ssis_data_type, sql_data_type FROM [internal].[data_type_mapping] ORDER BY ssis_data_type, sql_data_type;";
    public const string PropertiesSql = "SELECT property_name, CONVERT(nvarchar(4000), property_value) FROM [catalog].[catalog_properties] ORDER BY property_name;";

    private static string Literal(string value) => "N'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";
    private static int Int(string? text) => int.Parse(text!, CultureInfo.InvariantCulture);

    /// <summary>The catalog's shape. A fake has no internal schema, properties or type map: those come back empty.</summary>
    public static async Task<CatalogShape> ReadAsync(Func<string, string, Task<SqlRun>> run, string database, string source, bool fake = false)
    {
        async Task<List<string?[]>> Rows(string sql, string db)
        {
            var result = await run(sql, db);
            if (result.Status != "completed") throw new InvalidOperationException("Reading the catalog shape failed: " + result.Error);
            return result.Sets.Count == 0 ? [] : result.Sets[0];
        }
        var server = (await Rows("SELECT CONVERT(int, SERVERPROPERTY('ProductMajorVersion')), CONVERT(nvarchar(128), SERVERPROPERTY('ProductVersion'));", "master"))[0];
        var settings = (await Rows("SELECT compatibility_level, is_read_committed_snapshot_on, collation_name FROM sys.databases WHERE name = " + Literal(database) + ";", "master"))[0];
        var views = new Dictionary<string, List<ShapeColumn>>(StringComparer.Ordinal);
        foreach (var row in await Rows(string.Format(CultureInfo.InvariantCulture, ViewsSql, string.Format(CultureInfo.InvariantCulture, TypeJoin, "c")), database))
        {
            if (row[2] is null) throw new InvalidOperationException("Column " + row[0] + "." + row[1] + " has no type name.");
            (views.TryGetValue(row[0]!, out var columns) ? columns : views[row[0]!] = []).Add(new(row[1]!, row[2]!, Int(row[3]), Int(row[4]), Int(row[5]), row[6] == "1"));
        }
        var procedures = new Dictionary<string, List<ShapeParameter>>(StringComparer.Ordinal);
        var functions = new Dictionary<string, List<ShapeParameter>>(StringComparer.Ordinal);
        foreach (var row in await Rows(string.Format(CultureInfo.InvariantCulture, ModulesSql, string.Format(CultureInfo.InvariantCulture, TypeJoin, "p")), database))
        {
            var target = row[1]!.Trim() == "P" ? procedures : functions;
            var list = target.TryGetValue(row[0]!, out var parameters) ? parameters : target[row[0]!] = [];
            if (row[2] is not { } name) continue;
            if (row[3] is not { } type) throw new InvalidOperationException("Parameter " + row[0] + " " + name + " has no type name.");
            list.Add(new(name, type, Int(row[4]), row[5] == "1"));
        }
        foreach (var row in await Rows(HeadersSql, database))
        {
            var defaults = SsisManifest.Defaults(row[1] ?? "");
            foreach (var target in new[] { procedures, functions })
                if (target.TryGetValue(row[0]!, out var list))
                    for (var index = 0; index < list.Count; index++)
                        if (defaults.TryGetValue(list[index].Name, out var value)) list[index] = list[index] with { Default = value };
        }
        var refused = (await Rows(SqlAuthSql, database)).Select(row => row[0]!).ToList();
        if (fake)
            return new(Int(server[0]), source, server[1]!, "", "", new(Int(settings[0]), settings[1] == "1", settings[2]!), [], views, procedures, functions, [], [], [], refused, [], []);

        var properties = (await Rows(PropertiesSql, database)).ToDictionary(row => row[0]!, row => row[1] ?? "", StringComparer.Ordinal);
        var identities = (await Rows(IdentitiesSql, database)).Select(row => row[0]!).ToList();
        var indexes = new List<ShapeIndex>();
        foreach (var row in await Rows(IndexesSql, database))
            if (indexes.Count > 0 && indexes[^1].Table == row[0] && indexes[^1].Name == row[1]) indexes[^1].Keys.Add(row[5]!);
            else indexes.Add(new(row[0]!, row[1]!, row[2]!, row[3] == "1", row[4] == "1", [row[5]!]));
        var foreignKeys = new List<ShapeForeignKey>();
        foreach (var row in await Rows(ForeignKeysSql, database))
            if (foreignKeys.Count > 0 && foreignKeys[^1].Name == row[0]) foreignKeys[^1].Columns.Add(row[4]!);
            else foreignKeys.Add(new(row[0]!, row[1]!, row[2]!, row[3]!, [row[4]!]));
        var mapping = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (var row in await Rows(TypeMappingSql, database)) (mapping.TryGetValue(row[0]!, out var types) ? types : mapping[row[0]!] = []).Add(row[1]!);
        var errors = (await Rows("SELECT message_id, text FROM sys.messages WHERE language_id = 1033 AND message_id IN ("
                + string.Join(", ", SsisManifest.ErrorNumbers.Select(number => number.ToString(CultureInfo.InvariantCulture))) + ") ORDER BY message_id;", "master"))
            .ToDictionary(row => row[0]!, row => row[1]!, StringComparer.Ordinal);
        return new(Int(server[0]), source, server[1]!, properties.GetValueOrDefault("SCHEMA_VERSION", ""), properties.GetValueOrDefault("SCHEMA_BUILD", ""),
            new(Int(settings[0]), settings[1] == "1", settings[2]!), properties, views, procedures, functions, identities, indexes, foreignKeys, refused, mapping, errors);
    }
}
